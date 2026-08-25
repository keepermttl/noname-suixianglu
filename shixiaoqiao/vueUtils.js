import { lib, game, ui, get, ai, _status } from "../../../noname.js";
import { createApp } from "vue";

export function isMine(player) {
	// 用原版 player.isUnderControl(true, game.me) 判定"真人操控"：
	// 覆盖 2v2/4v4 开启代替队友行动(two_phaseswap/four_phaseswap)时队友也由真人控制的情况，
	// 避免把被接管的队友误判为 AI 直接跑 processAI 跳过技能选择 UI。
	return !!player && !_status.auto && player.isUnderControl(true, game.me);
}
/**
 * 用来处理vue的挂载、卸载+调用vue内部stopSpine方法清理动画等操作 vue内部调用confirm cancel自动resolve结果集
 * 把 switchToAuto 回调挂到当前事件对象上 —— 玩家点托管按钮时,
 *  ui.click.auto() 会直接调用 _status.event.switchToAuto(), 做到"点托管立即走 AI 逻辑"。
 */
export class VueUtils {
	/**
	 * @param {*} Vue Vue文件
	 * @param {*} vueOptions 传给vue的数据，vue里面要用哪些东西通过这个传递进来 包括里面的confirm和cancel方法
	 * @param {*} options ai处理逻辑
	 * @param {*} resolve ai处理后要调用promise的resolve
	 * @param {*} player 发动技能的玩家，用来判断是不是ai的
	 * @param {*} time 兜底监听托管的间隔(仅当拿不到事件对象时启用，默认1000ms)
	 */
	constructor(Vue, vueOptions = {}, options, resolve, player, time = 1000) {
		this.Vue = Vue;
		this.vueOptions = vueOptions;
		this.options = options;
		this.resolve = resolve;
		this.time = time;
		this.player = player;

		this.dialog = null;
		this.vmApp = null;
		this.vm = null;
		this.checkInterval = null;
		this.hookedEvent = null; // 被挂了 switchToAuto 的事件对象
		this.prevSwitchToAuto = null; // 被覆盖前的旧回调
		this.switchToAutoFn = null; // 我们挂上去的回调本体

		this.vueOptions.confirm = option => {
			this.clearDialog();
			this.resolve(option);
		};
		this.vueOptions.cancel = option => {
			this.clearDialog();
			this.resolve(option);
		};
		//玩家操控
		if (this.aiHandler()) {
			this.createVueVm();
			this.hookSwitchToAuto();
		}
	}
	createVueVm() {
		// 支持 vueOptions.containerClass 附加容器类(如 shenjiangwei 的黑幕 + z-index)
		const cls = ".wmmh-custom-dialog" + (this.vueOptions.containerClass ? " " + this.vueOptions.containerClass : "");
		this.dialog = ui.create.div(cls, document.body);
		// 支持 vueOptions.containerStyle 直接应用到最外层容器(如 shenjiangwei 把背景图放外层)
		if (this.vueOptions.containerStyle) {
			Object.assign(this.dialog.style, this.vueOptions.containerStyle);
		}
		this.vmApp = createApp(this.Vue, this.vueOptions);
		this.vmApp.mount(this.dialog);
		// 获取组件实例，用于调用 defineExpose 暴露的方法
		this.vm = this.vmApp._instance;
	}
	/**
	 * 把托管回调挂到当前事件对象上。
	 * content 执行期间 _status.event 就是当前技能事件，托管按钮 click 时会检查并调用它的 switchToAuto。
	 */
	hookSwitchToAuto() {
		const evt = _status.event;
		if (!evt) {
			// 兜底：极少数拿不到事件对象的情况退回定时器
			this.checkInterval = setInterval(() => {
				if (!isMine(this.player)) {
					this.clearDialog();
					this.runAI();
				}
			}, this.time);
			return;
		}
		this.hookedEvent = evt;
		this.prevSwitchToAuto = evt.switchToAuto;
		this.switchToAutoFn = () => {
			console.log("玩家点了托管");
			// 玩家点了托管：先清 UI(内部会恢复被覆盖的 switchToAuto)，再走 AI 兜底
			this.clearDialog();
			this.runAI();
		};
		evt.switchToAuto = this.switchToAutoFn;
	}
	/** AI 兜底：processAI 决策 → options.onAIFinish 收尾 → resolve 结果 */
	runAI() {
		let result;
		if (this.options.processAI) {
			result = this.options.processAI();
			// 执行 onAIFinish (AI/托管路径的清理工作，可选)
			if (this.options.onAIFinish) {
				this.options.onAIFinish();
			}
		}
		this.resolve(result);
	}
	aiHandler() {
		const isAI = !isMine(this.player);
		if (isAI && this.options.processAI) {
			console.log("AI 情况：执行 AI 逻辑");
			// AI 情况：执行 AI 逻辑
			this.runAI();
			// 默认清理
			this.clearDialog();
			// ai玩的 不需要走下去了，直接返回就可以了
			return false;
		}
		// 真人：挂载 UI（托管交给 hookSwitchToAuto 的事件回调处理，不再轮询）
		return true;
	}
	clearDialog() {
		// 调用 Vue 组件暴露的方法清理动画
		this.vm?.exposed?.stopSpine();
		this.vmApp?.unmount();
		this.vmApp = null;
		this.vm = null;
		this.dialog?.remove();
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
		// 恢复被覆盖的 switchToAuto（仅当它仍是挂的那个，避免误伤后挂的回调）
		if (this.hookedEvent && this.hookedEvent.switchToAuto === this.switchToAutoFn) {
			this.hookedEvent.switchToAuto = this.prevSwitchToAuto;
		}
		this.hookedEvent = null;
		this.prevSwitchToAuto = null;
		this.switchToAutoFn = null;
	}
}
