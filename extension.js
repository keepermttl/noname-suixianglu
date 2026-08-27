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

// ========== 权御 ==========
// 六项“权御”效果（与子技能同名）；辟邪/紫电/流星每人本局限选一次，
// 白虹/青冥/百里可跨轮重复叠加。
const QUANYU_EFFECTS = ["baihong", "qingming", "bixie", "zidian", "baili", "liuxing"];

// 魔孙权的“权御”效果池：所有角色（含已阵亡，永久累计）所选效果层数之和。
function getQuanyuPool() {
	const pool = {};
	for (const effect of QUANYU_EFFECTS) pool[effect] = 0;
	for (const target of game.players.concat(game.dead || [])) {
		for (const effect of QUANYU_EFFECTS) {
			pool[effect] += target.countMark(`suixiang_olquanyu_${effect}`);
		}
	}
	return pool;
}

// 每轮开始：所有角色同时为魔孙权选择两项“权御”效果（两项不可相同）。
// 天恩“对其发动一次权御”时经 createEvent 复用本函数：
// event.suixiang_retrigger=true 表示追加选择（本轮选择合并、不清空），
// event.suixiang_ownerLinks 提供重触发时用于摸牌比较的拥有者本轮选择。
async function quanyuRoundContent(event, trigger, player) {
	const result = await game
		.chooseAnyOL(
			event.targets,
			(target, player) => {
				const choices = QUANYU_EFFECTS.map(i => `suixiang_olquanyu_${i}`);
				return target
					.chooseButton(
						[
							'###权御###<div class="text center">请选择两项“权御”效果</div>',
							[choices.slice(0, 3).map(i => [i, lib.skill[i].description]), "tdnodes"],
							[choices.slice(3).map(i => [i, lib.skill[i].description]), "tdnodes"],
							[
								dialog => {
									dialog.buttons.forEach(i => {
										i.style.setProperty("width", "120px", "important");
										i.style.setProperty("text-align", "center", "important");
									});
								},
								"handle",
							],
						],
						true
					)
					.set("selectButton", [2, 2])
					.set("target", target)
					.set("filterButton", button => {
						// 辟邪（无视防具）/紫电（不可响应）/流星（无次数限制）不能重复选择：每人本局各限一次
						if (button.link == "suixiang_olquanyu_bixie" || button.link == "suixiang_olquanyu_zidian" || button.link == "suixiang_olquanyu_liuxing") {
							return !get.event().target.countMark(button.link);
						}
						return true;
					})
					.set("ai", () => 1 + Math.random())
					.set("_global_waiting", true);
			},
			[player]
		)
		.forResult();
	if (!result) return;
	let num = 0;
	const ownerLinks = result.get(player)?.links ?? event.suixiang_ownerLinks ?? [];
	// 本轮选择：正常轮次清空重建；天恩重触发时在既有本轮选择上合并
	const roundChoices = event.suixiang_retrigger ? player.getStorage("suixiang_olquanyu_round", {}) || {} : {};
	for (const [target, res] of result.entries()) {
		const links = res?.links;
		if (!links?.length) continue;
		// 永久叠加：addMark 自动同步 storage、挂标记并广播，标记数与层数一致
		for (const link of links) target.addMark(link, 1, false);
		roundChoices[target.playerid] = event.suixiang_retrigger
			? [...(roundChoices[target.playerid] || []), ...links]
			: links;
		// 摸牌计数：该角色本轮所选与你的本轮所选存在交集即算1人（自己恒算1人，与原版一致）
		if (links.some(link => ownerLinks.includes(link))) num++;
	}
	// 本轮选择入库并广播（供天恩比较）
	player.storage.suixiang_olquanyu_round = roundChoices;
	game.broadcast((player2, storage) => (player2.storage.suixiang_olquanyu_round = storage), player, roundChoices);
	if (num > 0) await player.draw(num);
}

// 使用伤害牌指定目标后：按效果池逐项执行。
async function quanyuUseCardContent(event, trigger, player) {
	const pool = getQuanyuPool();
	// 白虹：基础伤害+层数
	if (pool.baihong) {
		trigger.baseDamage = (trigger.baseDamage || 0) + pool.baihong;
		game.log(trigger.card, "的基础伤害+", pool.baihong);
	}
	// 青冥：每层+1个额外目标上限，一次弹窗自由选择（可选1~N个、可取消）
	if (pool.qingming) {
		const candidates = game.filterPlayer(target => {
			if (trigger.targets.includes(target)) return false;
			return lib.filter.targetEnabled2(trigger.card, player, target) && lib.filter.targetInRange(trigger.card, player, target);
		});
		if (candidates.length) {
			const maxSelect = Math.min(pool.qingming, candidates.length);
			const result =
				candidates.length > 1
					? await player
							.chooseTarget({
								prompt: `权御：为${get.translation(trigger.card)}选择至多${maxSelect}个额外目标`,
								selectTarget: [1, maxSelect],
								filterTarget(card, player, target) {
									const trigger2 = get.event().triggerx;
									if (trigger2.targets?.includes(target)) return false;
									return lib.filter.targetEnabled2(trigger2.card, player, target) && lib.filter.targetInRange(trigger2.card, player, target);
								},
								ai(target) {
									const { player, triggerx } = get.event();
									return get.effect(target, triggerx.card, player, player);
								},
							})
							.set("triggerx", trigger)
							.forResult()
					: { bool: true, targets: candidates };
			if (result?.bool && result.targets?.length) {
				const targets2 = result.targets.sortBySeat();
				player.line(targets2);
				trigger.targets.addArray(targets2);
				game.log(targets2, "成为了", trigger.card, "的额外目标");
			}
		}
	}
	// 辟邪：无视防具
	if (pool.bixie) {
		for (const target of trigger.targets) {
			target.addTempSkill("qinggang2");
			target.storage.qinggang2.add(trigger.card);
			target.markSkill("qinggang2");
		}
		game.log(trigger.card, "无视防具");
	}
	// 紫电：不可响应
	if (pool.zidian) {
		trigger.directHit.addArray(trigger.targets);
		game.log(trigger.card, "不可被响应");
	}
	// 百里：额外结算N次
	if (pool.baili) {
		trigger.effectCount += pool.baili;
		game.log(trigger.card, "额外结算", pool.baili, "次");
	}
	// 流星：无次数限制
	if (pool.liuxing && trigger.addCount !== false) {
		trigger.addCount = false;
		const stat = player.getStat().card,
			name = trigger.card.name;
		if (typeof stat[name] === "number") stat[name]--;
		game.log(trigger.card, "不计入次数");
	}
}

// ========== 天恩 ==========
// 使用牌指定一名角色为目标后：与该目标的本轮“权御”选择存在交集→得一张不计上限【杀】；
// 完全不同→随机弃其一张牌，再对其发动一次“权御”。无每回合次数限制、无唯一目标限制
// （多目标牌按目标逐个触发）。
async function tianenContent(event, trigger, player) {
	const target = trigger.target;
	const round = player.getStorage("suixiang_olquanyu_round", {}) || {};
	const playerChoices = round[player.playerid] || [];
	const targetChoices = round[target.playerid] || [];
	const same = targetChoices.some(link => playerChoices.includes(link));
	if (same) {
		// 相同：从牌堆获得一张不计入手牌上限的【杀】
		const card = get.cardPile("sha");
		if (card) {
			player.addSkill("suixiang_oltianen_effect");
			const next = player.gain(card, "gain2");
			next.gaintag.add("suixiang_oltianen_effect");
			await next;
		}
	} else {
		// 不同：随机弃置其一张牌，然后对其发动一次“权御”
		const cards = target.getDiscardableCards(player, "he");
		if (cards.length) {
			const next = target.discard(cards.randomGet());
			next.discarder = player;
			await next;
		}
		player.logSkill("suixiang_olquanyu", target);
		const next = game.createEvent("suixiang_olquanyu");
		next.player = player;
		next.targets = [target];
		next._trigger = event;
		next.setContent(lib.skill.suixiang_olquanyu.content);
		next.set("suixiang_retrigger", true);
		next.set("suixiang_ownerLinks", playerChoices);
		await next;
	}
}

// ========== 乾纲 ==========
// 该角色的“权御”标记总数（六项层数之和，用于乾纲各档效果判定）。
function getQuanyuMarkCount(player) {
	return QUANYU_EFFECTS.reduce((sum, effect) => sum + player.countMark(`suixiang_olquanyu_${effect}`), 0);
}

// 乾纲入魔特效与官方语音（资源已复制进扩展；无名美化缺失时静默跳过）。
function playQianGangFx() {
	try {
		game.playAudio("..", "extension", "随想录/audio/skin/suixiang-dm_sunquan/官方乾纲语音/Skill_MoSunQuan_3795_1.mp3");
	} catch (e) {}
	if (window.skinSwitch?.chukuangWorkerApi?.playEffect) {
		try {
			window.skinSwitch.chukuangWorkerApi.playEffect(
				{
					name: "../../../无名美化/animation/mosunquan/FX_MatchGame_mosunquan",
					version: "4.0",
					action: "play",
					json: true,
				},
				{
					speed: 1,
					scale: 1,
					x: [0, 0.5],
					y: [0, 0.5],
				}
			);
		} catch (e) {}
	}
}

// 乾纲内容：失去天恩并入魔，其他角色获得“乾纲”debuff状态技（永久）。
async function qiangangContent(event, trigger, player) {
	if (event.triggername === "damageEnd") {
		// 2枚：其他角色受到伤害后，魔孙权摸一张牌
		await player.draw();
		return;
	}
	player.addSkill("suixiang_olrumo");
	await player.removeSkills("suixiang_oltianen");
	for (const target of game.filterPlayer(target => target !== player)) {
		if (!target.hasSkill("suixiang_olqiangang_effect")) {
			target.addSkill("suixiang_olqiangang_effect");
			target.markSkill("suixiang_olqiangang_effect");
		}
	}
	playQianGangFx();
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
				suixiang_mb_jimie: "jimie",
			},
		};
	}
	// 无名美化「手杀神马超特效」（寂灭Spine大招动画，经十周年UI的 dcdAnim 播放）：
	// 原版只作用于 lib.skill.jimie，此处用同样的动画包装本武将的寂灭。
	if (lib.config?.["extension_无名美化_shenmachao"] && window.dcdAnim && lib.skill?.suixiang_mb_jimie) {
		const jimie = lib.skill.suixiang_mb_jimie;
		if (!jimie._suixiangAnimWrapped) {
			jimie._suixiangAnimWrapped = true;
			const original = jimie.content;
			const animName = "../../../无名美化/animation/shenmachao/SS_smc_dazhao";
			jimie.content = async function (event, trigger, player) {
				await new Promise((resolve) => {
					window.dcdAnim.loadSpine(animName, "skel", function () {
						let anim = window.dcdAnim.playSpine({ name: animName }, { x: [0, 0.5], y: [0, 0.5] });
						anim.oncomplete = () => {
							window.dcdAnim.stopSpine(anim);
							anim = null;
							resolve();
						};
					});
				});
				await original.call(this, event, trigger, player);
			};
		}
	}
}

// ========== 魔孙权与美化扩展兼容 ==========
// 十周年UI 动皮、千幻聆音皮肤/语音共享等扩展均按武将id查表；把新魔孙权注册为
// 原版 OL 魔孙权 dm_sunquan 的别名，使美化原版魔孙权的扩展同样作用于本武将。
function setupSunquanCompat() {
	// 十周年UI 动皮表（decadeUI.dynamicSkin）：共享原版魔孙权的 Spine 动皮
	if (window.decadeUI?.dynamicSkin) {
		const source = window.decadeUI.dynamicSkin.dm_sunquan;
		if (source && !window.decadeUI.dynamicSkin["suixiang-dm_sunquan"]) {
			window.decadeUI.dynamicSkin["suixiang-dm_sunquan"] = source;
		}
	}
	// 千幻聆音皮肤/语音共享表：新技能语音映射到原版同名技能（权御/天恩/乾纲均已实装）
	if (lib.qhly_skinShare) {
		lib.qhly_skinShare["suixiang-dm_sunquan"] = {
			name: "dm_sunquan",
			skills: {
				suixiang_olquanyu: "olquanyu",
				suixiang_oltianen: "oltianen",
				suixiang_olqiangang: "olqiangang",
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
			setupSunquanCompat();
			lib.arenaReady.push(setupShenMachaoCompat);
			lib.arenaReady.push(setupSunquanCompat);
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
						skills: ["suixiang_mb_yuli", "suixiang_mb_tingwei", "suixiang_mb_jimie"],
						names: "马|超",
						img: "extension/随想录/image/character/suixiang-mb_shen_machao.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-mb_shen_machao.mp3"],
					},
					// 魔孙权：在原版 OL 魔孙权 dm_sunquan 基础上再开发。
					// 性别/势力/体力与原版一致（male/wu/4）；立绘、阵亡语音为复制进扩展包的原版资源。
					// 技能：权御/天恩/乾纲/入魔全部实装（重构版，语音/选单/标记与原版一致）。
					// 技能语音已按技能id备于 audio/skill/suixiang_olquanyu* 等。
					"suixiang-dm_sunquan": {
						sex: "male",
						group: "wu",
						hp: 4,
						skills: ["suixiang_olquanyu", "suixiang_oltianen", "suixiang_olqiangang"],
						names: "孙|权",
						img: "extension/随想录/image/character/suixiang-dm_sunquan.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-dm_sunquan.mp3"],
					},
				},
				translate: {
					"suixiang-shi_xiaoqiao": "势 小乔",
					"suixiang-mb_shen_machao": "神 马超",
					"suixiang-dm_sunquan": "魔 孙权",
				},
				characterTitle: {
					"suixiang-shi_xiaoqiao": "衷音慰湟",
					"suixiang-mb_shen_machao": "势震九天",
					"suixiang-dm_sunquan": "隳堕的英谋",
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
							 * 记录驭雳两项的执行状态（与寂灭联动，结构沿用原版）：
							 * 寂灭发动过之后，驭雳的两项（造成雷伤/受到雷伤）都再次触发过，
							 * 则重置寂灭使其可再次发动。
							 */
							function updateState(player, type) {
								if (!player.awakenedSkills.includes("suixiang_mb_jimie")) return;
								switch (type) {
									case "atk":
										player.markAuto("suixiang_mb_yuli", ["atk"]);
										game.log(player, "触发了", "#g【驭雳】", "的第一项");
										break;
									case "def":
										player.markAuto("suixiang_mb_yuli", ["def"]);
										game.log(player, "触发了", "#g【驭雳】", "的第二项");
										break;
								}
								if (
									["atk", "def"].every((item) => player.getStorage("suixiang_mb_yuli").includes(item)) &&
									player.hasSkill("suixiang_mb_jimie", null, false, false)
								) {
									player.logSkill("suixiang_mb_jimie", null, null, null, [get.rand(3, 4)]);
									player.refreshSkill("suixiang_mb_jimie");
									player.setStorage("suixiang_mb_yuli", [], true);
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
					// ========== 寂灭（原版 jimie 直接移植，适配本武将的霆标记与驭雳状态） ==========
					suixiang_mb_jimie: {
						audio: "ext:随想录/audio/skill:4",
						trigger: { player: "phaseUseEnd" },
						limited: true,
						skillAnimation: true,
						filter(_event, player) {
							return player.countMark("suixiang_mb_tingwei") >= 8;
						},
						logAudio(event) {
							if (typeof event === "number") {
								return `ext:随想录/audio/skill/suixiang_mb_jimie${event}.mp3`;
							}
							return "ext:随想录/audio/skill/suixiang_mb_jimie2.mp3";
						},
						async cost(event, trigger, player) {
							event.result = await player
								.chooseTarget({
									prompt: get.prompt(event.skill),
									prompt2: "弃8枚“霆”标记，对一名角色造成等于其体力上限的伤害",
									ai(target) {
										const player = get.player();
										return get.damageEffect(target, player, player);
									},
								})
								.forResult();
						},
						async content(event, trigger, player) {
							player.awakenSkill("suixiang_mb_jimie");
							player.removeMark("suixiang_mb_tingwei", 8);
							const target = event.targets[0];
							await target.damage({ num: target.maxHp });
							player.setStorage("suixiang_mb_yuli", [], true);
						},
					},
					// ========== 权御（原版 olquanyu 重构：全员两项、永久叠加、全部伤害牌生效） ==========
					suixiang_olquanyu: {
						audio: "ext:随想录/audio/skill:2",
						trigger: {
							global: "roundStart",
							player: "useCard2",
						},
						filter(event, player, name) {
							if (name === "useCard2") {
								if (!get.is.damageCard(event.card) || !event.targets.length) return false;
								return QUANYU_EFFECTS.some(effect => getQuanyuPool()[effect] > 0);
							}
							return true;
						},
						forced: true,
						logTarget(event, player) {
							if (event.name === "useCard") return event.targets;
							return game.filterPlayer().sortBySeat(player);
						},
						async content(event, trigger, player) {
							if (event.triggername === "useCard2") {
								await quanyuUseCardContent(event, trigger, player);
								return;
							}
							await quanyuRoundContent(event, trigger, player);
						},
						mod: {
							cardUsableTarget(card, player, target) {
								// 流星：【杀】可额外指定目标（与原版一致）
								if (card.name !== "sha" || getQuanyuPool().liuxing <= 0) return;
								if (![...ui.selected.targets].remove(target).length) return true;
							},
						},
						ai: {
							unequip_ai: true,
							skillTagFilter(player, tag, arg) {
								if (!arg?.card || !arg.target || !get.is.damageCard(arg.card)) return false;
								return getQuanyuPool().bixie > 0;
							},
						},
						subSkill: {
							baihong: {
								description: "伤害+1",
								intro: {
									name: "白虹",
									content: ["伤害+1", '<span style="font-family:yuanli">“白虹贯苍穹，挥刃血溅宫”</span>'].join("<br><br>"),
								},
							},
							qingming: {
								description: "目标+1",
								intro: {
									name: "青冥",
									content: ["目标+1", '<span style="font-family:yuanli">“刃似寒潭水，剑出搠空明”</span>'].join("<br><br>"),
								},
							},
							bixie: {
								description: "无视防具",
								intro: {
									name: "辟邪",
									content: ["无视防具", '<span style="font-family:yuanli">“神锋所向诛邪恶，利刃飞出鬼魅惊”</span>'].join("<br><br>"),
								},
							},
							zidian: {
								description: "不可响应",
								intro: {
									name: "紫电",
									content: ["不可响应", '<span style="font-family:yuanli">“恰似明空紫电生，神兵舞起快如风”</span>'].join("<br><br>"),
								},
							},
							baili: {
								description: "额外结算",
								intro: {
									name: "百里",
									content: ["额外结算", '<span style="font-family:yuanli">“锋芒震四方，可息天下兵”</span>'].join("<br><br>"),
								},
							},
							liuxing: {
								description: "无次数",
								intro: {
									name: "流星",
									content: ["无次数限制", '<span style="font-family:yuanli">“流行飞玉弹，破阵清边尘”</span>'].join("<br><br>"),
								},
							},
						},
					},
					// ========== 天恩（原版 oltianen 移植：去掉每回合各限一次与唯一目标限制） ==========
					suixiang_oltianen: {
						audio: "ext:随想录/audio/skill:3",
						trigger: { player: "useCardToPlayered" },
						filter(event, player) {
							// 每指定一个目标触发一次：多目标牌按目标逐个结算
							const round = player.getStorage("suixiang_olquanyu_round", {}) || {};
							return !!round[player.playerid]?.length && !!round[event.target?.playerid]?.length;
						},
						forced: true,
						logTarget: "target",
						content: tianenContent,
						ai: { combo: "suixiang_olquanyu" },
						subSkill: {
							effect: {
								charlotte: true,
								mod: {
									ignoredHandcard(card, player) {
										if (card.hasGaintag("suixiang_oltianen_effect")) return true;
									},
									cardDiscardable(card, player, name) {
										if (name === "phaseDiscard" && card.hasGaintag("suixiang_oltianen_effect")) return false;
									},
								},
							},
						},
					},
					// ========== 乾纲（原版 olqiangang 重构：入魔+按权御标记数给其他角色叠debuff） ==========
					suixiang_olqiangang: {
						audio: "ext:随想录/audio/skill:3",
						enable: "phaseUse",
						filter(event, player, name) {
							if (name === "damageEnd") {
								// 2枚：其他角色受到伤害后，魔孙权摸一张牌（仅入魔后、仅其他角色、伤害未被防止）
								if (event._cancelled || !event.num) return false;
								if (!player.hasSkill("suixiang_olrumo", null, false, false)) return false;
								if (event.player === player) return false;
								return getQuanyuMarkCount(event.player) >= 2;
							}
							return !player.hasSkill("suixiang_olrumo", null, false, false) && player.hasSkill("suixiang_oltianen", null, false, false);
						},
						trigger: { global: "damageEnd" },
						direct: true,
						skillAnimation: true,
						animationColor: "wood",
						manualConfirm: true,
						content: qiangangContent,
						global: "suixiang_olqiangang_save",
						derivation: "suixiang_olrumo",
						ai: {
							order: 8,
							result: {
								player(player) {
									// 敌方权御标记越多越值得入魔
									const marks = game.filterPlayer(target => get.attitude(player, target) < 0).reduce((sum, target) => sum + getQuanyuMarkCount(target), 0);
									return marks >= 6 ? 1 : 0;
								},
							},
						},
					},
					// 乾纲debuff状态技：挂在其他角色身上，按其“权御”标记总数动态生效
					suixiang_olqiangang_effect: {
						charlotte: true,
						forced: true,
						silent: true,
						init(player, skill) {
							player.addSkillBlocker(skill);
						},
						onremove(player, skill) {
							player.removeSkillBlocker(skill);
						},
						skillBlocker(skill, player) {
							// 6枚：回合外非锁定技失效（缠怨同款）
							if (_status.currentPhase === player) return false;
							if (getQuanyuMarkCount(player) < 6) return false;
							const info = lib.skill[skill];
							return !(info.locked || info.charlotte || info.persevereSkill);
						},
						mod: {
							attackRange(card, player, range) {
								// 8枚：攻击距离始终为0
								if (getQuanyuMarkCount(player) >= 8) return 0;
							},
							cardUsable(card, player, num) {
								// 8枚：出杀次数始终为0
								if (getQuanyuMarkCount(player) >= 8 && card.name === "sha") return 0;
							},
							maxHandcard(card, player, num) {
								// 8枚：手牌上限始终为0
								if (getQuanyuMarkCount(player) >= 8) return 0;
							},
						},
						mark: true,
						marktext: "纲",
						intro: {
							name: "乾纲",
							content(storage, player) {
								const n = getQuanyuMarkCount(player);
								let str = `当前拥有${n}枚“权御”标记。`;
								const tiers = [
									[2, "你受到伤害后，魔孙权摸一张牌"],
									[4, "你进入濒死时，只能使用【酒】回复体力"],
									[6, "回合外你的非锁定技失效"],
									[8, "你的攻击距离、出杀次数与手牌上限始终为0"],
								];
								const active = tiers.filter(([t]) => n >= t);
								if (active.length) {
									str += "<br>已生效：" + active.map(([, text]) => `<li>${text}`).join("");
								} else {
									str += "<br>暂未生效（需2枚“权御”标记）";
								}
								return str;
							},
						},
					},
					// 乾纲全局技能：4枚角色濒死时禁止一切体力恢复（豁免【酒】）
					suixiang_olqiangang_save: {
						trigger: { global: "recoverBegin" },
						filter(event, player) {
							const target = event.player;
							if (!target?.isDying()) return false;
							if (!target.hasSkill("suixiang_olqiangang_effect") || getQuanyuMarkCount(target) < 4) return false;
							// 豁免【酒】
							if (event.card && get.name(event.card) === "jiu") return false;
							return true;
						},
						forced: true,
						popup: false,
						async content(event, trigger, player) {
							trigger.cancel();
							game.log(trigger.player, "的体力恢复被", "#g【乾纲】", "禁止");
						},
					},
					// 入魔：原版 olrumo 状态技
					suixiang_olrumo: {
						charlotte: true,
						trigger: { global: "roundEnd" },
						filter(event, player) {
							return !player.getRoundHistory("sourceDamage", evt => evt.num > 0).length;
						},
						forced: true,
						popup: false,
						content() {
							player.loseHp();
						},
						nopop: true,
						mark: true,
						marktext: "魔",
						intro: { content: "你已入魔" },
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
					suixiang_mb_jimie: "寂灭",
					suixiang_mb_jimie_info:
						"限定技，出牌阶段结束时，你可以弃8个“霆”标记，对一名角色造成等于其体力上限的伤害。然后当你【驭雳】的两项均执行后，此技能视为未发动过。",
					suixiang_olquanyu: "权御",
					suixiang_olquanyu_info:
						"锁定技。每轮开始时，所有角色同时为你选择两项“权御”效果（两项不可相同；辟邪、紫电与流星本局每人限选一次），然后你摸X张牌（X为其中与你本轮选择相同的角色数，不设上限）。你使用伤害牌指定目标后，执行全部“权御”效果：白虹：基础伤害+1；青冥：选择至多X个额外目标（X为青冥层数，可自由选择数量）；辟邪：无视防具；紫电：不可响应；百里：额外结算一次；流星：无次数限制。所有角色的选择永久累计并强化你。",
					suixiang_olquanyu_baihong: "白虹",
					suixiang_olquanyu_qingming: "青冥",
					suixiang_olquanyu_bixie: "辟邪",
					suixiang_olquanyu_zidian: "紫电",
					suixiang_olquanyu_baili: "百里",
					suixiang_olquanyu_liuxing: "流星",
					// 权御台词（原版魔孙权，键按扩展音频路径生成）
					"#ext:随想录/audio/skill/suixiang_olquanyu1": "百川奔流入海，却尽入朕之彀中。",
					"#ext:随想录/audio/skill/suixiang_olquanyu2": "恩威予取，功过皆在朕心。",
					// 天恩台词（原版魔孙权，键按扩展音频路径生成）
					"#ext:随想录/audio/skill/suixiang_oltianen1": "臣是薪，恩是火，莫让朕寒了心。",
					"#ext:随想录/audio/skill/suixiang_oltianen2": "雷霆雨露，俱是朕赏你的。",
					"#ext:随想录/audio/skill/suixiang_oltianen3": "庙堂之上，贤良忠臣独汝一人？",
					suixiang_oltianen: "天恩",
					suixiang_oltianen_info:
						"锁定技。你使用牌指定一名角色为目标后：若你与其本轮的“权御”选择存在相同效果，你从牌堆获得一张不计入手牌上限的【杀】；若完全不同，你随机弃置其一张牌，然后对其发动一次“权御”。",
					suixiang_oltianen_effect: "不计上限",
					// 乾纲台词（原版魔孙权，键按扩展音频路径生成）
					"#ext:随想录/audio/skill/suixiang_olqiangang1": "清浊之分，朕说无用便是无用。",
					"#ext:随想录/audio/skill/suixiang_olqiangang2": "这天下欠朕的，该还了。",
					"#ext:随想录/audio/skill/suixiang_olqiangang3": "朕心即天意，卿当跪听天怒！",
					suixiang_olqiangang: "乾纲",
					suixiang_olqiangang_info:
						"出牌阶段，你可失去〖天恩〗并入魔，然后其他角色根据其拥有的“权御”标记数获得效果：2枚，其受到伤害后，你摸一张牌；4枚，其进入濒死时，只能使用【酒】回复体力；6枚，回合外其非锁定技失效；8枚，其攻击距离、出杀次数与手牌上限始终为0。",
					suixiang_olqiangang_effect: "乾纲",
					suixiang_olrumo: "入魔",
					suixiang_olrumo_info: "每局游戏限一次。入魔后，每轮结束时，若本轮你未造成过伤害，你失去1点体力。",
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
					"#ext:随想录/audio/skill/suixiang_mb_jimie1": "万物重归于寂，天地唯颂我名！",
					"#ext:随想录/audio/skill/suixiang_mb_jimie2": "赐万物寂然，赐万界终灭！",
					"#ext:随想录/audio/skill/suixiang_mb_jimie3": "此世终末之时，我将再度照临！",
					"#ext:随想录/audio/skill/suixiang_mb_jimie4": "我乃万法之法，戮神之神！",
					"#ext:随想录/audio/die/suixiang-mb_shen_machao:die": "我裁万世，何以裁我……",
					"#ext:随想录/audio/die/suixiang-dm_sunquan:die": "朕非朕，天下皆朕！",
				},
			},
			intro: "随想录扩展：所有武将/技能均以 suixiang 为前缀。下载地址：https://github.com/keepermttl/noname-suixianglu",
			author: "伽拉忒亚",
			version: "1.3.7",
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
