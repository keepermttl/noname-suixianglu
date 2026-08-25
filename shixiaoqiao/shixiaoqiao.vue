<template>
	<div class="wmmh-custom-zhezhao"></div>
	<div class="shixq-container" v-show="anLoaded">
		<div class="shixq-list">
			<div v-for="item in list" :key="item.value" @click="selectFn(item.value)" :class="['shixq-item', selected === item.value ? 'shixq-item-active' : 'shixq-item-nomal']">
				<div class="shixq-title">
					{{ item.label }}
				</div>
				<div class="shixq-info" v-html="item.info"></div>
			</div>
		</div>
	</div>
	<div class="shixq-footer" v-show="anLoaded">
		<div class="shixq-footer-btn">
			<div class="shixq-confirm-btn" @click="confirmFn" :class="{ disabled: !selected }">确认</div>
			<div v-if="props.skillName === 'heyun'" class="shixq-cancel-btn" @click="cancelFn">取消</div>
		</div>
		<div class="shixq-jdt" ref="jindutiao">
			<div class="progress-mask" :style="{ width: progress + '%' }">
				<img src="extension/无名美化/image/shixiaoqiao/jnmb_sxq_txt_jindutiao2.png" alt="" />
			</div>
			<img class="shixq-lianhua" :style="{ left: (progress - 20) * 5.87 + 'px' }" src="extension/无名美化/image/shixiaoqiao/jnmb_sxq_hh_loop.webp" alt="" srcset="" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted, defineExpose, watch } from "vue";
// import { lib, get } from "noname";
import { loadSpinePromise } from "../../无名美化/utils/utils.js";
interface Props {
	list: Array<{
		value: string;
		label: string;
		info: string;
	}>;
	skillName: string;
	confirm: (option: Object) => void;
	cancel: (option: Object) => void;
}
interface anObj {
	[key: string]: object | null;
}
const jindutiao = ref(null);
//动画是否加载完毕
let anLoaded: boolean = ref(false);
let isMounted: boolean = ref(false);
//进度条动画
let progress = ref(100);
//动画信息对象
let xqAn = {
	// 红莲花 play入场 loop
	hh: {
		name: "../../../无名美化/animation/shixiaoqiao/Ss_vfx_sxq_ui_hh",
	},
	// play合韵入场  play2音洄入场  loop合韵固定 loop2音洄固定
	hy: {
		name: "../../../无名美化/animation/shixiaoqiao/Ss_vfx_sxq_ui_hy",
		y: [190, 0.5],
		scale: 0.8,
	},
	// 进度条动画
	jdt: {
		name: "../../../无名美化/animation/shixiaoqiao/Ss_vfx_sxq_ui_jdt",
	},
	// 选择框背景动画 play入场 切换 loop
	jm: {
		name: "../../../无名美化/animation/shixiaoqiao/Ss_vfx_sxq_ui_jm",
		scale: 0.7,
	},
	// 选择框动画
	// xz: {
	// 	name: "../../../无名美化/animation/shixiaoqiao/Ss_vfx_sxq_ui_xz",
	// },
	//淡入动画
	// effect_glow: {
	// 	name: "../../../无名美化/animation/shixiaoqiao/Ss_vfx_sxq_effect_glow",
	// },
};
//预加载所有动画 确保动画播放层级正确
let loadAll = Promise.all([loadSpinePromise(xqAn.hh.name), loadSpinePromise(xqAn.hy.name), loadSpinePromise(xqAn.jdt.name), loadSpinePromise(xqAn.jm.name)]);
//循环播放的动画对象，方便后面停止
let anObj: anObj = {
	jm: null,
	hyTitle: null,
};
//全部加载完成后 背景框动画标题动画 等待500ms 后播放循环动画
loadAll.then(() => {
	window.playJdt = () => {
		dcdAnim.playSpine({
			...xqAn.jdt,
		});
	};
	// 加载完成后执行
	dcdAnim.playSpine({
		...xqAn.jm,
		action: "play",
	});
	dcdAnim.playSpine({
		...xqAn.hy,
		action: props.skillName === "heyun" ? "play" : "play2",
	});
	let t: any = setTimeout(() => {
		clearTimeout(t);
		t = null;
		anObj.jm = dcdAnim.playSpine({
			...xqAn.jm,
			action: "loop",
			loop: true,
		});
		anObj.hyTitle = dcdAnim.playSpine({
			...xqAn.hy,
			action: props.skillName === "heyun" ? "loop" : "loop2",
			loop: true,
		});
		anLoaded.value = true;
	}, 500);
});

onMounted(() => {
	isMounted.value = true;
});
//挂载完毕&动画加载完毕 播放进度条动画
watch([isMounted, anLoaded], ([newVal1, newVal2]) => {
	if (newVal1 && newVal2) {
		let tjdt: any = setInterval(() => {
			if (progress.value > 0) {
				progress.value -= 1;
			} else {
				clearInterval(tjdt);
				tjdt = null;
			}
		}, 100);
		dcdAnim.playSpine(
			{
				...xqAn.jdt,
			},
			{
				parent: jindutiao.value,
			}
		);
	}
});
//jnmb_sxq_hh_loop.webp 进度条莲花动画图片
// jnmb_sxq_btn.png 确认按钮可点击背景  默认白色背景
// jnmb_sxq_btn2.png 取消按钮背景
//jnmb_sxq_txt_di.png 技能选择框背景
// jnmb_sxq_txt_di2.png 技能选择框选中背景
//jnmb_sxq_txt_jindutiao1.png 进度条背景
//jnmb_sxq_txt_jindutiao2.png 进度条动画背景

const props = defineProps<Props>();
let selected = ref("");
const selectFn = (value: string) => {
	if (selected.value === value) {
		selected.value = "";
	} else {
		selected.value = value;
	}
};
const stopSpine = () => {
	Object.keys(anObj).forEach(key => {
		if (anObj[key]) {
			dcdAnim.stopSpine(anObj[key]);
			anObj[key] = null;
		}
	});
};
const confirmFn = () => {
	console.log(selected.value);
	if (!selected.value) {
		return;
	}
	let params = {
		links: [selected.value],
		bool: true,
	};
	stopSpine();
	console.log(params);
	props.confirm(params);
};
const cancelFn = () => {
	stopSpine();
	props.cancel({ bool: false });
};

defineExpose({
	stopSpine,
});
</script>
