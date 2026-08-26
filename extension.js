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
// 清除该技能的发动次数统计、每轮计数、临时封禁与临时子技能，并重置限定技。
// 注意：storage 只清精确键（技能自身 / _roundcount / temp_ban_），不做前缀匹配删除——
// 否则会误删子技能的 storage（如 dcwumei_wake），导致残留子技能 filter 读 undefined 崩溃。
function refreshSkill(player, skills) {
	if (typeof skills === "string") skills = [skills];
	const suffixs = ["used", "round", "block", "blocker"];
	for (const skill of skills) {
		delete player.storage[skill];
		delete player.storage[skill + "_roundcount"];
		delete player.storage["temp_ban_" + skill];
		const info = get.info(skill);
		if (info.usable !== undefined) {
			if (typeof player.getStat("triggerSkill")[skill] == "number" && player.getStat("triggerSkill")[skill] >= 1) {
				delete player.getStat("triggerSkill")[skill];
			}
			if (typeof player.getStat("skill")[skill] == "number" && player.getStat("skill")[skill] >= 1) {
				delete player.getStat("skill")[skill];
			}
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

// ========== 神马超与美化扩展兼容 ==========
// 十周年UI 动皮、千幻聆音语音共享等扩展均按武将id查表；把新神马超注册为
// 原版神马超的别名，使美化原版神马超的扩展同样作用于本武将。
function setupShenMachaoCompat() {
	// 十周年UI 动皮表（decadeUI.dynamicSkin）：共享原版神马超的动皮
	if (window.decadeUI?.dynamicSkin) {
		const source =
			window.decadeUI.dynamicSkin.shen_machao || window.decadeUI.dynamicSkin.mb_shen_machao;
		if (source && !window.decadeUI.dynamicSkin["suixiang-mb_shen_machao"]) {
			window.decadeUI.dynamicSkin["suixiang-mb_shen_machao"] = source;
		}
	}
	// 千幻聆音语音共享表：新技能语音映射到原版同名技能
	if (lib.qhly_skinShare) {
		lib.qhly_skinShare["suixiang-mb_shen_machao"] = {
			name: "mb_shen_machao",
			skills: {
				suixiang_mb_yuli: "yuli",
				suixiang_mb_tingwei: "tingwei",
			},
		};
	}
}

export const type = "extension";

export default function () {
	return {
		name: "随想录",
		content(config, pack) {
			// 立即尝试（美化扩展已加载时生效），并在游戏就绪后兜底（美化扩展后加载时生效）
			setupShenMachaoCompat();
			lib.arenaReady.push(setupShenMachaoCompat);
		},
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
					// 神马超：在原版手杀神马超 mb_shen_machao 基础上再开发。
					// 性别/势力/体力与原版一致；立绘、阵亡语音为复制进扩展包的原版资源。
					"suixiang-mb_shen_machao": {
						sex: "male",
						group: "shen",
						hp: 4,
						skills: ["suixiang_mb_yuli", "suixiang_mb_tingwei"],
						names: "马|超",
						img: "extension/随想录/image/character/suixiang-mb_shen_machao.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-mb_shen_machao.mp3"],
					},
				},
				translate: {
					"suixiang-shi_xiaoqiao": "势 小乔",
					"suixiang-mb_shen_machao": "神 马超",
				},
				characterTitle: {
					"suixiang-shi_xiaoqiao": "衷音慰湟",
					"suixiang-mb_shen_machao": "势震九天",
				},
			},
			skill: {
				skill: {
					// ========== 驭雳（基于原版 yuli 改动：新增相邻角色溅射扩散） ==========
					suixiang_mb_yuli: {
						audio: "ext:随想录/audio/skill:6",
						trigger: {
							source: ["damageBegin1", "damageEnd"],
							player: "damageBegin4",
						},
						filter(event, player, name) {
							if (name === "damageBegin1") {
								// 溅射伤害不再吃"改为雷电/雷伤+1"
								return !event.suixiang_mb_yuli_splash;
							}
							if (name === "damageEnd") {
								// 伤害结算完成后扩散：按改雷+1后的伤害值>1，且伤害未被防止
								return event.suixiang_mb_yuli_splash > 1 && !event._cancelled;
							}
							// damageBegin4：受到雷电伤害时免疫并摸牌
							return event.hasNature("thunder");
						},
						forced: true,
						locked: true,
						logAudio(event) {
							if (typeof event === "number") {
								return `ext:随想录/audio/skill/suixiang_mb_yuli${event}.mp3`;
							}
							// 与原版一致：常规触发随机播第1/2条
							return [
								"ext:随想录/audio/skill/suixiang_mb_yuli1.mp3",
								"ext:随想录/audio/skill/suixiang_mb_yuli2.mp3",
							];
						},
						async content(event, trigger, player) {
							switch (event.triggername) {
								case "damageBegin1": {
									if (!trigger.hasNature("thunder")) {
										player.logSkill("suixiang_mb_yuli");
										game.setNature(trigger, "thunder");
									} else {
										player.logSkill("suixiang_mb_yuli", null, null, null, [get.rand(3, 4)]);
										trigger.num++;
									}
									// 记录扩散基数（改为雷电/加值后的最终伤害值），待伤害结算完成后扩散
									if (trigger.num > 1) trigger.suixiang_mb_yuli_splash = trigger.num;
									updateState(player, "atk");
									break;
								}
								case "damageEnd": {
									// 扩散：对受伤害者相邻的存活角色各造成一半（向下取整）雷电伤害。
									// 扩散伤害不再受"雷伤+1"，但若仍高于1点会继续向外扩散；
									// 扩散伤害同样吃驭雳的免伤摸牌（打到自己时免疫并摸牌）。
									const splashNum = Math.floor(trigger.suixiang_mb_yuli_splash / 2);
									const victim = trigger.player;
									const targets = [victim.getNext(), victim.getPrevious()].filter((t) => t && !t.isDead());
									const unique = [];
									for (const t of targets) {
										if (!unique.includes(t)) unique.push(t);
									}
									player.logSkill("suixiang_mb_yuli", null, null, null, [get.rand(3, 4)]);
									for (const t of unique) {
										await t
											.damage({
												source: player,
												num: splashNum,
												nature: "thunder",
											})
											.set("suixiang_mb_yuli_splash", splashNum);
									}
									break;
								}
								case "damageBegin4": {
									player.logSkill("suixiang_mb_yuli", null, null, null, [get.rand(5, 6)]);
									trigger.cancel();
									await player.draw(trigger.num);
									updateState(player, "def");
									break;
								}
							}
							return;

							/**
							 * 记录驭雳两项的执行状态（结构沿用原版，供后续寂灭刷新机制使用）
							 */
							function updateState(player, type) {
								// 寂灭尚未加入本武将，暂不生效；待 suixiang_mb_jimie 实装后启用
								if (!player.awakenedSkills.includes("suixiang_mb_jimie")) return;
								switch (type) {
									case "atk":
										player.markAuto("suixiang_mb_yuli", ["atk"]);
										break;
									case "def":
										player.markAuto("suixiang_mb_yuli", ["def"]);
										break;
								}
							}
						},
						onremove: true,
						intro: {
							content(storage = [], player) {
								if (!storage?.length) return "尚未触发【驭雳】的任一项";
								let str = "已触发【驭雳】的";
								if (storage.includes("atk")) {
									str += "第一项";
									if (storage.includes("def")) str += "和";
								}
								if (storage.includes("def")) str += "第二项";
								return str;
							},
						},
						ai: {
							nothunder: true,
							effect: {
								target(card, player, target, current) {
									if (get.tag(card, "thunderDamage")) return "zeroplayertarget";
								},
							},
						},
					},
					// ========== 霆威（基于原版 tingwei 改动：伤害牌触发、由自己选择、效果对所有目标生效） ==========
					suixiang_mb_tingwei: {
						audio: "ext:随想录/audio/skill:4",
						trigger: { player: "useCard0" },
						filter(event, player) {
							// 使用伤害牌指定目标后（useCard0 时该牌目标已全部指定）
							return get.tag(event.card, "damage") && event.targets.some((t) => t !== player);
						},
						forced: true,
						locked: true,
						logAudio(event) {
							if (typeof event === "number") {
								return `ext:随想录/audio/skill/suixiang_mb_tingwei${event}.mp3`;
							}
							return "ext:随想录/audio/skill/suixiang_mb_tingwei2.mp3";
						},
						async content(event, trigger, player) {
							// 必定获得4枚“霆”标记（无论是否选择选项）
							player.addMark("suixiang_mb_tingwei", 4);
							const result = await player
								.chooseButton({
									createDialog: [
										"霆威：请选择任意项，每选一项消耗1枚“霆”标记（点击“取消”则不选择）",
										[
											[
												["fengyin", "目标本回合非锁定技失效"],
												["give", "目标交给你一张牌"],
												["damage", `${get.translation(trigger.card)}对目标造成伤害+1`],
												["sha", "本回合使用【杀】的次数上限+1"],
												["link", "目标进入连环状态"],
											],
											"textbutton",
										],
									],
									selectButton: [1, 4],
									processAI() {
										const event = get.event();
										const player = event.player;
										const trigger = event.useCardEvent;
										// 霆标记价值：基础1，接近寂灭阈值(8)时递增，当前回合内更容易触发再+2
										const mark = player.countMark("suixiang_mb_tingwei");
										let markValue = 1;
										if (mark >= 8) markValue += 7;
										else if (mark >= 6) markValue += 2.5;
										else if (mark >= 5) markValue += 1.5;
										if (_status.currentPhase === player) markValue += 2;
										const costs = { fengyin: 0, give: 0, damage: 0, sha: 0, link: 0 };
										for (const t of trigger.targets) {
											if (get.attitude(player, t) >= 0) continue;
											const skills = t
												.getSkills(null, false, false)
												.filter((s) => {
													const info = get.info(s);
													return info && !info.locked && !info.charlotte;
												});
											costs.fengyin += skills.length * 1.2;
											const givable = t.getGainableCards(player, "he");
											if (givable.length) {
												costs.give += Math.min(
													3,
													givable.reduce((sum, c) => sum + get.value(c, t), 0) / givable.length
												);
											}
											costs.damage += Math.max(
												0,
												-get.damageEffect(t, player, player, get.nature(trigger.card))
											);
											if (!t.isLinked()) costs.link += 1.5;
										}
										if (
											player.countCards("hs", (c) => get.name(c) === "sha") > 0 &&
											!player.hasSkillTag("freeSha", null, null, true)
										) {
											costs.sha = 0.8;
										}
										const links = [];
										for (const key of ["fengyin", "give", "damage", "sha", "link"]) {
											if (costs[key] > markValue) links.push(key);
										}
										if (links.length) {
											return { bool: true, links: links.slice(0, 4) };
										}
										return { bool: false };
									},
								})
								.set("useCardEvent", trigger)
								.forResult();

							if (!result?.bool || !result.links?.length) return; // 未选择：只获得标记

							player.removeMark("suixiang_mb_tingwei", result.links.length);
							for (const link of ["fengyin", "give", "damage", "sha", "link"]) {
								if (!result.links.includes(link)) continue;
								switch (link) {
									case "fengyin": {
										// 本回合非锁定技失效（当前回合结束即恢复）
										for (const t of trigger.targets) {
											t.addTempSkill("suixiang_mb_tingwei_fengyin");
										}
										break;
									}
									case "give": {
										for (const t of trigger.targets) {
											// 目标无牌时此项对其不生效
											if (!t.countGainableCards(player, "he")) continue;
											await t.chooseToGive({
												target: player,
												position: "he",
												forced: true,
											});
										}
										break;
									}
									case "damage": {
										// 沿用原版 customArgs.extraDamage 通道：该牌对所有目标造成的伤害+1
										const map = trigger.customArgs;
										if (!map) break;
										for (const t of trigger.targets) {
											if (!map[t.playerid]) map[t.playerid] = {};
											if (typeof map[t.playerid].extraDamage != "number") {
												map[t.playerid].extraDamage = 0;
											}
											map[t.playerid].extraDamage++;
										}
										break;
									}
									case "sha": {
										player.addTempSkill("suixiang_mb_tingwei_sha", "phaseAfter");
										player.addMark("suixiang_mb_tingwei_sha", 1, false);
										break;
									}
									case "link": {
										player.logSkill("suixiang_mb_tingwei", null, null, null, [get.rand(3, 4)]);
										for (const t of trigger.targets) {
											await t.link(true);
										}
										break;
									}
								}
							}
						},
						mark: true,
						marktext: "霆",
						intro: {
							name: "霆",
							content: "当前拥有#个“霆”标记",
						},
						subSkill: {
							fengyin: {
								inherit: "fengyin",
							},
							sha: {
								charlotte: true,
								onremove: true,
								marktext: "杀",
								intro: {
									content: "本回合使用【杀】的次数上限+#",
								},
								mod: {
									cardUsable(card, player, num) {
										if (card.name == "sha") {
											return num + player.countMark("suixiang_mb_tingwei_sha");
										}
									},
								},
							},
						},
						ai: {
							// 霆标记对寂灭（后续技能）有储备价值：AI 出牌时倾向保留标记
							effect: {
								player(card, player, target, current) {
									if (get.tag(card, "damage") && player.countMark("suixiang_mb_tingwei") < 8) {
										return 0.9;
									}
								},
							},
						},
					},
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
					suixiang_mb_yuli: "驭雳",
					suixiang_mb_yuli_info:
						"锁定技。造成的伤害改为雷电伤害，若原版伤害已经是雷电伤害则伤害增加1点。当造成高于1点的雷电伤害时会额外对目标相邻的角色造成一半伤害（向下取整）。受到雷电伤害时免疫雷电伤害并摸等量牌。",
					suixiang_mb_tingwei: "霆威",
					suixiang_mb_tingwei_info:
						"锁定技。使用伤害牌指定目标后，你获得4个“霆”标记，然后你可以选择以下任意项（每选一项消耗1个“霆”标记）：1.目标本回合非锁定技失效；2.目标交给你一张牌；3.此伤害牌对目标造成的伤害+1；4.本回合使用【杀】的次数上限+1；5.目标进入连环状态。每项效果对该牌的所有目标生效。",
					suixiang_heyun: "和韵",
					suixiang_heyun_info:
						"出牌阶段限两次，你可以选择自己或一名与你拥有相同技能的角色，令其失去一个你选择的武将牌上技能（装备技能除外），然后其摸两张牌。每回合你首次进入濒死时，你可以对自己发动此技能，失去一个你选择的武将牌上技能（装备技能除外），摸两张牌，然后回复至1点体力。",
					suixiang_yinhui: "音洄",
					suixiang_yinhui_info:
						"每轮开始时，或当你失去技能时，你可以选择一名其他角色，获得其武将牌上当前拥有的一个技能（装备技能除外）。",
					suixiang_yinhui_lose: "音洄",
					// 驭雳台词（原版手杀神马超，键按扩展音频路径生成）
					"#ext:随想录/audio/skill/suixiang_mb_yuli1": "驭元始之用，执生杀之机！",
					"#ext:随想录/audio/skill/suixiang_mb_yuli2": "号令雷霆，上照天心！",
					"#ext:随想录/audio/skill/suixiang_mb_yuli3": "抗我神威者，俱为齑粉！",
					"#ext:随想录/audio/skill/suixiang_mb_yuli4": "万钧所压，再无生还！",
					"#ext:随想录/audio/skill/suixiang_mb_yuli5": "惊霆九殛，锻我神魂！",
					"#ext:随想录/audio/skill/suixiang_mb_yuli6": "玄雷淬锋，砺我神威！",
					"#ext:随想录/audio/skill/suixiang_mb_tingwei1": "尔可再问汝心，岂欲与天一战？",
					"#ext:随想录/audio/skill/suixiang_mb_tingwei2": "望我者惧怖，闻我者悚骇！",
					"#ext:随想录/audio/skill/suixiang_mb_tingwei3": "雷敕已传，三界难逃！",
					"#ext:随想录/audio/skill/suixiang_mb_tingwei4": "跪下！迎接你的神罚！",
					"#ext:随想录/audio/die/suixiang-mb_shen_machao:die": "我裁万世，何以裁我……",
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
