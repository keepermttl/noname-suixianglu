import { lib, game, ui, get, ai, _status } from "../../noname.js";
import { VueUtils } from "./shixiaoqiao/vueUtils.js";

// ========== 通用工具 ==========
// 可失去/可获得的"武将牌上技能"：有名称、有描述、非装备、非状态技、非子技能、非隐藏技能。
function getStealableSkills(player) {
	return player.getSkills(null, false, false).filter((skill) => {
		if (!lib.translate[skill] || !lib.translate[skill + "_info"]) return false;
		const info = get.info(skill);
		if (!info) return false;
		if (info.charlotte || info.sub || info.hidden) return false;
		return true;
	});
}

// 濒死标记（联机同步的布尔 storage）
function setHeyunDyingFlag(player, value) {
	player.storage.suixiang_heyun_dying = value;
	game.broadcastAll(function (player2, value2) {
		player2.storage.suixiang_heyun_dying = value2;
	}, player, value);
}

// ========== 技能选择面板 ==========
// 优先使用移植自「无名美化」的势小乔 Vue 面板；无名美化缺失时动态 import 失败，
// 自动回退到引擎原生 chooseButton 面板，不再硬依赖其他扩展。
let shixiaoqiaoVue = null;
let vueImportTried = false;
async function getVuePanel() {
	if (!vueImportTried) {
		vueImportTried = true;
		try {
			const mod = await import("./shixiaoqiao/shixiaoqiao.vue");
			shixiaoqiaoVue = mod.default;
		} catch (e) {
			console.warn("[随想录] 无名美化 Vue 面板不可用，已回退原生技能选择面板：", e);
		}
	}
	return shixiaoqiaoVue;
}
function createXq(player, VueOptions, options) {
	return new Promise((resolve) => {
		const list = [];
		for (const skill of VueOptions.list) {
			list.push({
				value: skill,
				label: get.translation(skill),
				info: lib.translate[skill + "_info"] || "暂无描述",
			});
		}
		VueOptions.list = list;
		new VueUtils(shixiaoqiaoVue, VueOptions, options, resolve, player);
	});
}
// AI/托管时的技能挑选：避开组合技、限定技、负面技
function pickSkillAI(skillList) {
	if (!skillList.length) return { bool: false };
	const good = skillList.filter((skill) => {
		const info = get.info(skill);
		return info && !(info.ai && (info.ai.combo || info.ai.notemp || info.ai.neg));
	});
	const pool = good.length ? good : skillList;
	return { bool: true, links: [pool[Math.floor(Math.random() * pool.length)]] };
}
async function openSkillPanel(player, skillList, skillName, dialogTitle) {
	const Vue = await getVuePanel();
	if (Vue) {
		return await createXq(
			player,
			{ list: skillList.slice(), skillName },
			{ processAI: () => pickSkillAI(skillList) }
		);
	}
	const list = [];
	for (const skill of skillList) {
		list.push([
			skill,
			`<div class="popup text" style="width:calc(100% - 10px);display:inline-block"><div class="skill">【${get.translation(skill)}】</div><div>${lib.translate[skill + "_info"]}</div></div>`,
		]);
	}
	return await player
		.chooseButton({
			createDialog: [dialogTitle, [list, "textbutton"]],
			forced: true,
			ai(button) {
				const info = get.info(button.link);
				if (!info || (info.ai && (info.ai.combo || info.ai.notemp || info.ai.neg))) return 0;
				return 1 + Math.random();
			},
		})
		.forResult();
}

// ========== 音洄 ==========
// 引擎约定（1.11.6 源码验证）：filter(event, player, triggername, indexedData) 的
// 第一个参数是"被触发的事件本身"（如 changeSkills 事件，name=="changeSkills"），
// 触发时机名必须用第三个参数 triggername 区分；TriggerEvent 的 name 恒为 "trigger"。
function yinhuiFilter(event, player, name) {
	if (name == "roundStart") {
		// 主技能：每轮开始时，场上存在其他角色可偷的技能
		return game.hasPlayer(
			(target) =>
				target !== player &&
				getStealableSkills(target).some((skill) => !player.hasSkill(skill))
		);
	}
	if (name == "changeSkillsAfter") {
		// 子技能：只有"玩家真正失去技能（快照口径含常驻/偷来的/临时技能）"才触发。
		// 快照由 track 子技能在 changeSkillsBefore 时直接挂在本事件对象上
		// （Before→After 是同一个 changeSkills 事件对象，天然免 storage、免联机同步）。
		if (!event.removeSkill || !event.removeSkill.length) return false;
		const snapshot = event.suixiang_yinhui_snapshot;
		if (!snapshot || !event.removeSkill.some((skill) => snapshot.includes(skill))) return false;
		return game.hasPlayer(
			(target) =>
				target !== player &&
				getStealableSkills(target).some((skill) => !player.hasSkill(skill))
		);
	}
	return false;
}
async function yinhuiCost(event, trigger, player) {
	event.result = await player
		.chooseTarget({
			prompt: get.prompt2("suixiang_yinhui"),
			selectTarget: [1, 1],
			filterTarget(card, player2, target) {
				if (target === player2) return false;
				return getStealableSkills(target).some((skill) => !player2.hasSkill(skill));
			},
			ai(target) {
				const player2 = get.event().player;
				const skills = getStealableSkills(target).filter((skill) => !player2.hasSkill(skill));
				if (!skills.length) return 0;
				return (
					Math.max(...skills.map((skill) => get.skillRank(skill))) +
					(get.attitude(player2, target) < 0 ? 2 : 0)
				);
			},
		})
		.forResult();
}
async function yinhuiContent(event, trigger, player) {
	const target = event.targets[0];
	if (!target) return;
	const skillList = getStealableSkills(target).filter((skill) => !player.hasSkill(skill));
	if (!skillList.length) return;
	const result =
		skillList.length > 1
			? await openSkillPanel(player, skillList, "yinhui", "音洄：请选择一个技能")
			: { bool: true, links: skillList };
	if (result?.bool && result.links?.length) {
		const skill = result.links[0];
		// 获得前刷新技能状态：清除 storage/发动次数/临时子技能、重置限定技，
		// 使技能如"全新获得"（失去后再获得可再次发动）。
		refreshSkill(player, skill);
		// 走 additionalSkills 机制获得技能：自动 game.log、走 changeSkills 事件、
		// 可被 getSkills 正确枚举；keep=true 不移除此前获得的技能（本技能无清除环节）。
		await player.addAdditionalSkills("suixiang_yinhui", skill, true);
	}
}

// 刷新获得的技能状态（参考官方势小乔 potyinhui.refreshSkill / 朱佩兰写法）：
// 清除该技能的 storage 残留、发动次数统计、每轮计数、临时封禁与临时子技能，并重置限定技。
function refreshSkill(player, skills) {
	if (typeof skills === "string") skills = [skills];
	Object.keys(player.storage)
		.filter((i) => skills.some((skill) => i.startsWith(skill)))
		.forEach((storage) => delete player.storage[storage]);
	const suffixs = ["used", "round", "block", "blocker"];
	for (const skill of skills) {
		const info = get.info(skill);
		if (info.usable !== undefined) {
			if (typeof player.getStat("triggerSkill")[skill] == "number" && player.getStat("triggerSkill")[skill] >= 1) {
				delete player.getStat("triggerSkill")[skill];
			}
			if (typeof player.getStat("skill")[skill] == "number" && player.getStat("skill")[skill] >= 1) {
				delete player.getStat("skill")[skill];
			}
		}
		if (info.round && player.storage[skill + "_roundcount"]) {
			delete player.storage[skill + "_roundcount"];
		}
		if (player.storage[`temp_ban_${skill}`]) {
			delete player.storage[`temp_ban_${skill}`];
		}
		if (player.awakenedSkills.includes(skill)) {
			player.restoreSkill(skill);
		}
		for (const suffix of suffixs) {
			if (player.hasSkill(skill + "_" + suffix)) {
				player.removeSkill(skill + "_" + suffix);
			}
		}
	}
}

// ========== 和韵 ==========
// 和韵可选目标：自己，或与自己拥有同名技能的角色；且目标有可失去的技能。
function heyunFilterTarget(card, player, target) {
	if (!getStealableSkills(target).length) return false;
	if (target === player) return true;
	return getStealableSkills(target).some((skill) => player.hasSkill(skill));
}
async function heyunContent(event, trigger, player) {
	const target = event.targets[0];
	if (!target) return;
	// 删除该角色（自己或同名技能角色）身上的任意技能
	const skills = getStealableSkills(target);
	if (!skills.length) return;
	const result =
		skills.length > 1
			? await openSkillPanel(player, skills, "heyun", "和韵：请选择其失去的技能")
			: { bool: true, links: skills };
	if (result?.bool && result.links?.length) {
		await target.changeSkills([], [result.links[0]]);
		await target.draw(2);
	}
}

export const type = "extension";

export default function () {
	return {
		name: "随想录",
		content(config, pack) {},
		package: {
			character: {
				character: {
					"suixiang-shi_xiaoqiao": {
						sex: "female",
						group: "wu",
						hp: 3,
						maxHp: 3,
						skills: ["suixiang_heyun", "suixiang_yinhui"],
						names: "桥|null",
						img: "extension/随想录/image/character/suixiang-shi_xiaoqiao.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-shi_xiaoqiao.mp3"],
					},
				},
				translate: {
					"suixiang-shi_xiaoqiao": "势 小乔",
				},
				characterTitle: {
					"suixiang-shi_xiaoqiao": "衷音慰湟",
				},
			},
			skill: {
				skill: {
					suixiang_heyun: {
						audio: "ext:随想录/audio/skill:2",
						enable: "phaseUse",
						usable: 2,
						filter(event, player) {
							return game.hasPlayer((current) => heyunFilterTarget(null, player, current));
						},
						filterTarget(card, player, target) {
							return heyunFilterTarget(card, player, target);
						},
						selectTarget: 1,
						content: heyunContent,
						ai: {
							order: 1,
							result: {
								target(player, target) {
									return -get.attitude(player, target);
								},
							},
						},
						group: ["suixiang_heyun_dying", "suixiang_heyun_reset"],
						subSkill: {
							dying: {
								audio: "suixiang_heyun",
								trigger: { player: "dying" },
								filter(event, player) {
									return (
										!player.storage.suixiang_heyun_dying &&
										getStealableSkills(player).length > 0
									);
								},
								async cost(event, trigger, player) {
									setHeyunDyingFlag(player, true);
									const result = await player
										.chooseBool("是否发动【和韵】？")
										.set("ai", () => player.hp <= 0)
										.forResult();
									event.result = { bool: result.bool };
								},
								async content(event, trigger, player) {
									const skills = getStealableSkills(player);
									if (!skills.length) return;
									const result =
										skills.length > 1
											? await openSkillPanel(player, skills, "heyun", "和韵：请选择自己失去的技能")
											: { bool: true, links: skills };
									if (result?.bool && result.links?.length) {
										await player.changeSkills([], [result.links[0]]);
										await player.draw(2);
										await player.recoverTo(1);
									}
								},
							},
							reset: {
								trigger: { global: "phaseBegin" },
								forced: true,
								silent: true,
								charlotte: true,
								async content(event, trigger, player) {
									setHeyunDyingFlag(player, false);
								},
							},
						},
					},
					suixiang_yinhui: {
						audio: "ext:随想录/audio/skill:12",
						skillAnimation: true,
						animationColor: "water",
						trigger: { global: "roundStart" },
						filter: yinhuiFilter,
						cost: yinhuiCost,
						content: yinhuiContent,
						group: ["suixiang_yinhui_lose", "suixiang_yinhui_track"],
						subSkill: {
							lose: {
								audio: "suixiang_yinhui",
								trigger: { player: "changeSkillsAfter" },
								filter: yinhuiFilter,
								cost: yinhuiCost,
								content: yinhuiContent,
							},
							track: {
								trigger: { player: "changeSkillsBefore" },
								forced: true,
								silent: true,
								charlotte: true,
								async content(event, trigger, player) {
									// 快照口径与引擎 changeSkills 的 removeSkill 过滤口径一致
									// （content.js: ownedSkills = player.getSkills(true, false, false)）：
									// 含常驻技能 + additionalSkills（音洄偷来的技能）+ 临时技能，不含装备。
									trigger.suixiang_yinhui_snapshot = player.getSkills(true, false, false);
								},
							},
						},
					},
				},
				translate: {
					suixiang_heyun: "和韵",
					suixiang_heyun_info:
						"出牌阶段限两次，你可以选择自己或一名与你拥有相同技能的角色，令其失去一个你选择的武将牌上技能（装备技能除外），然后其摸两张牌。每回合你首次进入濒死时，你可以对自己发动此技能，失去一个你选择的武将牌上技能（装备技能除外），摸两张牌，然后回复至1点体力。",
					suixiang_yinhui: "音洄",
					suixiang_yinhui_info:
						"每轮开始时，或当你失去技能时，你可以选择一名其他角色，获得其武将牌上当前拥有的一个技能（装备技能除外）。",
					suixiang_yinhui_lose: "音洄",
				},
			},
			intro: "随想录扩展：所有武将/技能均以 suixiang 为前缀。",
			author: "无名玩家",
			version: "1.0",
		},
		files: {
			character: [],
			card: [],
			skill: [],
			audio: [],
		},
		editable: false,
		connect: false,
	};
};
