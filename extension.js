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

function isKemingTransferableSkill(skill) {
	if (!lib.translate[skill] || !lib.translate[skill + "_info"]) return false;
	const info = get.info(skill);
	return !!info && !info.charlotte && !info.sub && !info.hidden;
}

function getKemingTargetCharacterNames(target) {
	return [...new Set([target.name1, target.name2, target.name].filter((name) => name && get.character(name)))];
}

function getKemingTargetSkillOptions(target, skills) {
	const characters = getKemingTargetCharacterNames(target);
	const fallback = characters[0] || "shibing";
	return skills.map((skill) => ({
		skill,
		character: characters.find((name) => (get.character(name)?.skills || []).includes(skill)) || fallback,
	}));
}

function getKemingCharacterPool(target, excludedSkills = [], pool = "surname") {
	if (!_status.characterlist) game.initCharacterList();
	const excluded = new Set(excludedSkills);
	const targetNames = getKemingTargetCharacterNames(target);
	const surnames = new Set(
		targetNames.flatMap((name) => get.characterSurname(name).map(([surname]) => surname).filter(Boolean)),
	);
	return (_status.characterlist || [])
		.filter((name) => {
			const info = get.character(name);
			return (
				info &&
				!targetNames.includes(name) &&
				get.characterSurname(name).some(([surname]) => (pool === "cao" ? surname === "曹" : surnames.has(surname))) &&
				(info.skills || []).some((skill) => isKemingTransferableSkill(skill) && !excluded.has(skill))
			);
		});
}

function getKemingSurnameSkillOptions(target, excludedSkills = [], pool = "surname") {
	const characters = getKemingCharacterPool(target, excludedSkills, pool).randomGets(3);
	const excluded = new Set(excludedSkills);
	const options = new Map();
	for (const name of characters) {
		for (const skill of get.character(name)?.skills || []) {
			if (isKemingTransferableSkill(skill) && !excluded.has(skill) && !options.has(skill)) options.set(skill, name);
		}
	}
	return [...options].map(([skill, character]) => ({ skill, character }));
}

function getKemingSkillChoiceDialog(title, options) {
	// 原生 skill 按钮以来源武将立绘作底图，右键可查看技能描述。
	const buttons = options.map(({ skill, character }) => [skill, character]);
	return [title, [buttons, "skill"]];
}

function getKemingDamageTarget(event, triggername) {
	return triggername === "damageSource" ? event.player : event.source;
}

const yinzhiBlockSkill = "suixiang_dc_yinzhi_block";
const yinzhiTurnSkill = "suixiang_dc_yinzhi_turn";

function getYinzhiTurnTag(player) {
	return `${yinzhiTurnSkill}_${player.playerid}`;
}

function getYinzhiCardMaterials(card) {
	if (get.itemtype(card) === "card") return [card];
	return card?.cards || [];
}

function yinzhiUsedHandCard(event, player) {
	if (event.getl?.(player)?.hs?.length) return true;
	return player.getHistory("lose", (loss) => loss.parent === event && loss.hs?.length > 0).length > 0;
}

function removeYinzhiOwner(owner) {
	const ownerId = owner.playerid;
	for (const target of game.players.concat(game.dead)) {
		const block = target.storage[yinzhiBlockSkill];
		if (block?.owners?.includes(ownerId)) {
			block.owners.remove(ownerId);
			if (!block.owners.length) target.removeSkill(yinzhiBlockSkill);
		}
		const turn = target.storage[yinzhiTurnSkill];
		if (turn?.owners?.includes(ownerId)) {
			turn.owners.remove(ownerId);
			if (!turn.owners.length) target.removeSkill(yinzhiTurnSkill);
		}
	}
}

// 濒死标记（联机同步的布尔 storage）
function setHeyunDyingFlag(player, value) {
	player.storage.suixiang_heyun_dying = value;
	game.broadcastAll(function (player2, value2) {
		player2.storage.suixiang_heyun_dying = value2;
	}, player, value);
}

// ========== 武翊（势赵云） ===========
function getWuyiNames(player) {
	const names = player.getStorage("suixiang_wuyi");
	return Array.isArray(names) ? names : [];
}
function getWuyiLevel(player) {
	return getWuyiNames(player).length;
}
function hasWuyiSkill(player) {
	return player.hasSkill("suixiang_wuyi", null, null, false);
}
function getCuifengUnlocks(player) {
	const unlocks = player.getStorage("suixiang_cuifeng_unlocked");
	return Array.isArray(unlocks) ? unlocks : [];
}
function getMouKanpoCardList(excludeName) {
	const seen = new Set();
	return get.inpileVCardList(info => info[2] !== "sha" || !info[3]).filter(info => {
		const name = info[2];
		if (!name || name === excludeName || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}
function consumeMouKanpoRecord(records, name) {
	const index = records.indexOf(name);
	if (index < 0) return false;
	records.splice(index, 1);
	return true;
}
function setMouHuojiFlag(player, name, value) {
	player.storage[name] = value;
	game.broadcastAll((current, key, nextValue) => {
		current.storage[key] = nextValue;
	}, player, name, value);
}
function getMouHuojiDamageEvent(event) {
	if (event?.reason?.name === "damage") return event.reason;
	if (event?.parent?.name === "damage") return event.parent;
	return event?.getParent?.("damage", true) || null;
}
const MOU_GUANXING_TAG = "suixiang_mou_guanxing";
const MOU_XING_TAG = "suixiang_mou_xing";
function isMouGuanxingCard(card) {
	// 观星牌始终保留牌堆取出的实体牌；这里仅读取引擎判定时附带的实体牌引用，
	// 不调用视为牌/复制牌接口，也不改写 card 本身。
	return (
		card?.hasGaintag?.(MOU_GUANXING_TAG) ||
		(Array.isArray(card?.cards) && card.cards.some(cardx => cardx?.hasGaintag?.(MOU_GUANXING_TAG)))
	);
}
function getMouGuanxingCards(player) {
	const state = lib.suixiang_mou_guanxing_api?.deckState;
	if (state?.owner === player) {
		const visible = player.getCards("s", card => card.hasGaintag(MOU_GUANXING_TAG));
		return state.cards.filter(card => visible.includes(card)).concat(visible.filter(card => !state.cards.includes(card)));
	}
	return player.getCards("s", card => card.hasGaintag(MOU_GUANXING_TAG));
}
function isMouXingCard(card) {
	return card?.hasGaintag?.(MOU_XING_TAG) || (Array.isArray(card?.cards) && card.cards.some(cardx => cardx?.hasGaintag?.(MOU_XING_TAG)));
}
function getMouXingCards(player) {
	return [...player.getCards("s", card => card.hasGaintag(MOU_XING_TAG)), ...player.getCards("x", card => card.hasGaintag(MOU_XING_TAG))];
}
function getMouGuanxingUsableCards(player) {
	return [...getMouGuanxingCards(player), ...getMouXingCards(player)];
}
function setupMouZhugeliangCardCompat() {
	const zhangba = lib.skill?.zhangba_skill;
	if (zhangba && !zhangba._suixiangMouXingCompat) {
		const originalFilterCard = zhangba.filterCard;
		zhangba.position = "hs";
		zhangba.filterCard = function (card, player, ...args) {
			if (player?.getCards("s").includes(card) && !isMouXingCard(card) && !isMouGuanxingCard(card)) return false;
			if (player?.getCards("x").includes(card) && !isMouXingCard(card)) return false;
			if (typeof originalFilterCard === "function") return originalFilterCard.call(this, card, player, ...args);
			return originalFilterCard !== false;
		};
		zhangba.filter = function (event, player) {
			const expansionStars = getMouXingCards(player).filter(card => player.getCards("x").includes(card)).length;
			return player.countCards("hs") + expansionStars >= 2;
		};
		zhangba._suixiangMouXingCompat = true;
	}
	const guanshi = lib.skill?.guanshi_skill;
	if (guanshi && !guanshi._suixiangMouXingCompat) {
		guanshi.filter = function (event, player) {
			if (event.type !== "card" || event.card.name !== "sha" || !event.target?.isIn()) return false;
			let min = 2;
			if (!player.hasSkill("guanshi_skill", null, false)) {
				min += player.hasCards("e", card => get.name(card) === "guanshi") ? 1 : 0;
			}
			return player.countCards("he") + getMouGuanxingUsableCards(player).length >= min;
		};
		guanshi._suixiangMouXingCompat = true;
	}
}
function extendMouUsePosition(event, player) {
	const availableCards = getMouGuanxingUsableCards(player);
	if (!availableCards.length || typeof event.position !== "string" || !event.position.includes("h")) return;
	for (const [position, cards] of [["s", availableCards], ["x", player.getCards("x", card => card.hasGaintag(MOU_XING_TAG))]]) {
		if (cards.length && !event.position.includes(position)) {
			event.position += position;
		}
	}
	const allowedCards = new Set(availableCards);
	const specialCards = new Set([...player.getCards("s"), ...player.getCards("x")]);
	const originalFilter = typeof event.filterCard === "function" ? event.filterCard : lib.filter.all;
	event.filterCard = function (card, currentPlayer, ...args) {
		if (currentPlayer === player) {
			const cards = Array.isArray(card?.cards) ? card.cards : [card];
			const selectedSpecialCards = cards.filter(cardx => specialCards.has(cardx));
			if (selectedSpecialCards.some(cardx => !allowedCards.has(cardx))) {
				return false;
			}
		}
		return originalFilter.call(this, card, currentPlayer, ...args);
	};
}
function isMouGuanxingDiscardEvent(event) {
	const huogong = event.getParent?.(current => current.name === "huogong" || current.card?.name === "huogong", true, true);
	const position = typeof event.position === "string" ? event.position : "h";
	const isHuogong = Boolean(huogong && position.includes("h"));
	const isGuanshi = event.logSkill === "guanshi_skill" && position.includes("h") && position.includes("e");
	return isHuogong || isGuanshi;
}
function extendMouDiscardPosition(event, player) {
	const isGuanshi = event.logSkill === "guanshi_skill";
	const allowedCards = isGuanshi
		? new Set([...player.getCards("he"), ...getMouGuanxingUsableCards(player)])
		: new Set([...player.getCards("h"), ...getMouGuanxingUsableCards(player)]);
	if (!event.position.includes("s")) event.position += "s";
	if (!event.position.includes("x")) event.position += "x";
	const originalFilter = typeof event.filterCard === "function" ? event.filterCard : lib.filter.cardDiscardable;
	event.filterCard = function (card, currentPlayer, ...args) {
		if (currentPlayer === player && !allowedCards.has(card)) return false;
		return originalFilter.call(this, card, currentPlayer, ...args);
	};
}
async function fillMouGuanxingCards(player) {
	if (!player?.hasSkill?.("suixiang_mou_guanxing")) return;
	const state = lib.suixiang_mou_guanxing_api.deckState;
	if (state.owner && state.owner !== player) return;
	state.owner = player;
	const current = getMouGuanxingCards(player);
	const need = Math.max(0, 7 - current.length);
	if (need) {
		const cards = state.drawPhysicalCards ? state.drawPhysicalCards(need) : get.cards(need);
		if (cards.length) {
			player.directgains(cards, undefined, MOU_GUANXING_TAG);
			state.cards.push(...cards);
		}
	}
	state.ready = true;
	if (getMouGuanxingCards(player).length) player.markSkill("suixiang_mou_guanxing");
}
async function arrangeMouGuanxingCards(player) {
	const cards = getMouGuanxingCards(player);
	if (!cards.length) return;
	const result = await player
		.chooseToMove({
			prompt: "观星：调整牌堆顶七张牌的顺序，可将任意张牌置于牌堆底",
			list: [["牌堆顶（左为顶）", cards], ["牌堆底（左为底）"]],
		})
		.forResult();
	if (!result?.bool || !Array.isArray(result.moved)) return;
	const topCards = Array.isArray(result.moved[0]) ? result.moved[0].slice() : [];
	const bottomCards = Array.isArray(result.moved[1]) ? result.moved[1].slice() : [];
	player._suixiang_mou_guanxing_arranging = true;
	try {
		const state = lib.suixiang_mou_guanxing_api.deckState;
		state.cards = topCards.slice();
		if (bottomCards.length) {
			const moveBottom = player.loseToDiscardpile({
				cards: bottomCards,
				position: ui.cardPile,
				log: false,
				animate: false,
			});
			moveBottom.log = false;
			moveBottom.animate = false;
			await moveBottom;
			for (const card of bottomCards) card.removeGaintag?.(MOU_GUANXING_TAG);
		}
	} finally {
		delete player._suixiang_mou_guanxing_arranging;
	}
	await fillMouGuanxingCards(player);
}
function removeMouGuanxingCards(player, cards) {
	const state = lib.suixiang_mou_guanxing_api?.deckState;
	if (state?.owner !== player || !Array.isArray(cards) || !cards.length) return;
	const removed = new Set(cards);
	state.cards = state.cards.filter(card => !removed.has(card));
}
function takeMouGuanxingTopCards(num, putBack, drawRemaining) {
	const state = lib.suixiang_mou_guanxing_api?.deckState;
	if (!state?.ready || !state.owner || !state.owner.hasSkill?.("suixiang_mou_guanxing") || typeof num === "number" && num <= 0) {
		return drawRemaining(num, putBack);
	}
	const count = typeof num === "number" ? Math.ceil(num) : 1;
	const visible = state.cards.splice(0, Math.min(count, state.cards.length));
	for (const card of visible) {
		card.remove();
		card.original = "c";
		card.classList?.remove("glows");
		card.classList?.remove("drawinghidden");
		if (!putBack) card.removeGaintag?.(MOU_GUANXING_TAG);
	}
	const remaining = count - visible.length;
	const fromPile = remaining > 0 ? drawRemaining(remaining, putBack) : [];
	if (putBack) {
		state.cards.unshift(...visible);
		if (visible.length && state.owner) state.owner.directgains(visible, undefined, MOU_GUANXING_TAG);
	} else if (state.owner.hasSkill?.("suixiang_mou_guanxing") && state.cards.length < 7) {
		const refill = state.drawPhysicalCards ? state.drawPhysicalCards(7 - state.cards.length) : [];
		if (refill.length) {
			state.owner.directgains(refill, undefined, MOU_GUANXING_TAG);
			state.cards.push(...refill);
		}
	}
	return visible.concat(fromPile);
}
function setupMouGuanxingPlayerTopCardsCompat() {
	// 摸牌、判定等流程在部分模式中优先调用 Player#getTopCards，需和 get.cards 共用同一逻辑牌堆顶。
	const prototype = lib.element?.Player?.prototype;
	const targets = [prototype, ...(game.players || []), ...(game.dead || [])].filter(Boolean);
	for (const target of targets) {
		if (target.getTopCards?._suixiangMouGuanxingCompat) continue;
		const originalGetTopCards = target.getTopCards;
		const wrapped = function (num, ...args) {
			return takeMouGuanxingTopCards(num, false, (count, putBack) => {
				if (typeof originalGetTopCards === "function") return originalGetTopCards.call(this, count, ...args);
				return get._suixiangMouGuanxingDeckCompat(count, putBack);
			});
		};
		wrapped._suixiangMouGuanxingCompat = true;
		target.getTopCards = wrapped;
	}
}
function setupMouGuanxingDeckCompat() {
	const state = lib.suixiang_mou_guanxing_api?.deckState;
	if (get._suixiangMouGuanxingDeckCompat) {
		if (state && !state.drawPhysicalCards) state.drawPhysicalCards = get._suixiangMouGuanxingDeckCompat;
		setupMouGuanxingPlayerTopCardsCompat();
		return;
	}
	const originalGetCards = get.cards;
	if (typeof originalGetCards !== "function") return;
	if (state) state.drawPhysicalCards = originalGetCards.bind(get);
	get.cards = function (num, putBack) {
		return takeMouGuanxingTopCards(num, putBack, (count, shouldPutBack) => originalGetCards.call(this, count, shouldPutBack));
	};
	get._suixiangMouGuanxingDeckCompat = originalGetCards.bind(get);
	setupMouGuanxingPlayerTopCardsCompat();
}
function refreshCuifengUnlocks(player, force = false) {
	if (!force && !hasWuyiSkill(player)) return getCuifengUnlocks(player);
	const additions = ["unrecorded"];
	for (const name of getWuyiNames(player)) {
		if (["sha", "shan", "jiu", "tao"].includes(name)) additions.push(name);
	}
	const unlocks = getCuifengUnlocks(player);
	const fresh = additions.filter((name) => !unlocks.includes(name));
	if (fresh.length) player.markAuto("suixiang_cuifeng_unlocked", fresh);
	return getCuifengUnlocks(player);
}
function getBasicCardNames() {
	return lib.inpile.filter((name) => get.type(name) === "basic").unique();
}
function recordWuyiName(player, name) {
	if (!name || getWuyiNames(player).includes(name)) return false;
	player.markAuto("suixiang_wuyi", name);
	if (hasWuyiSkill(player)) refreshCuifengUnlocks(player);
	return true;
}
async function applyWuyiProgress(player) {
	if (!hasWuyiSkill(player)) return;
	const level = getWuyiLevel(player);
	refreshCuifengUnlocks(player);
	if (level >= 2 && !player.additionalSkills?.suixiang_wuyi?.includes("suixiang_longhun")) {
		player.addAdditionalSkill("suixiang_wuyi", "suixiang_longhun");
	}
	if (level >= 3) applyWuyiBlock(player);
	if (level >= 4) await adjustWuyiHand(player);
}
function addCuifengJiu(target) {
	target.addTempSkill("suixiang_cuifeng_jiu", { player: "dieAfter" });
	target.addMark("suixiang_cuifeng_jiu", 1, false);
}
function addCuifengTao(target) {
	target.addTempSkill("suixiang_cuifeng_tao", { player: "phaseJieshuBegin" });
}
function invalidateCuifengResponse(event) {
	const response = event.getParent?.("chooseToRespond");
	const result = {
		...(response?.result && typeof response.result === "object" ? response.result : {}),
		bool: false,
		card: null,
		cards: [],
	};
	if (response) response.result = result;
	event.result = result;
}
function getCuifengDuelContext(event, player) {
	const use = event.getParent((current) => current.name === "useCard" && current.card?.name === "juedou");
	if (!use || use.player !== player || !Array.isArray(use.targets)) return null;
	const snapshot = use.suixiang_cuifeng_snapshot;
	if (!snapshot || !Array.isArray(snapshot.unlocks)) return null;
	const targetDamage = use.targets.includes(event.player);
	if (!targetDamage && event.player !== use.player) return null;
	return { use, snapshot, targetDamage };
}
function applyWuyiBlock(player, force = false) {
	if (getWuyiLevel(player) < 3 || (!force && _status.currentPhase !== player)) return;
	for (const target of game.filterPlayer((current) => current !== player)) {
		target.addTempSkill("suixiang_wuyi_block", { global: "phaseAfter" });
	}
}
async function adjustWuyiHand(player) {
	if (getWuyiLevel(player) < 4 || player._suixiang_wuyi_adjusting) return;
	const handCount = player.countCards("h");
	if (handCount === 4) return;
	player._suixiang_wuyi_adjusting = true;
	try {
		if (handCount < 4) {
			await player.draw(4 - handCount);
			return;
		}
		const needDiscard = handCount - 4;
		const discardable = player.countDiscardableCards(player, "h");
		if (discardable > 0) {
			await player
				.chooseToDiscard({
					forced: true,
					position: "h",
					selectCard: Math.min(needDiscard, discardable),
					prompt: "武翊：请选择要弃置的牌",
				})
				.forResult();
		}
	} finally {
		delete player._suixiang_wuyi_adjusting;
	}
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
	// 青冥：每层+1个额外目标上限；逐层询问、每层限选1个，点取消即停止（可选0~N个，不会被自动全选）
	if (pool.qingming) {
		let left = pool.qingming;
		while (left > 0) {
			const candidates = game.filterPlayer(target => {
				if (trigger.targets.includes(target)) return false;
				return lib.filter.targetEnabled2(trigger.card, player, target) && lib.filter.targetInRange(trigger.card, player, target);
			});
			if (!candidates.length) break;
			const result = await player
				.chooseTarget({
					prompt: `权御：为${get.translation(trigger.card)}额外选择一个目标（还可选择${left}个，点击取消停止）`,
					selectTarget: 1,
					filterTarget(card, player, target) {
						const trigger2 = get.event().triggerx;
						if (trigger2.targets?.includes(target)) return false;
						return lib.filter.targetEnabled2(trigger2.card, player, target) && lib.filter.targetInRange(trigger2.card, player, target);
					},
					ai(target) {
						const { player, triggerx } = get.event();
						return get.effect(target, triggerx.card, player, player);
					},
					processAI() {
						const event = get.event();
						const { player, triggerx: trigger2 } = event;
						const list = game.filterPlayer(target => event.filterTarget(null, player, target));
						const good = list.filter(target => get.effect(target, trigger2.card, player, player) < 0);
						if (!good.length) return { bool: false };
						return { bool: true, targets: good.slice(0, 1) };
					},
				})
				.set("triggerx", trigger)
				.set("noAutoSelect", true)
				.forResult();
			if (result?.bool && result.targets?.length) {
				const targets2 = result.targets.sortBySeat();
				player.line(targets2);
				trigger.targets.addArray(targets2);
				game.log(targets2, "成为了", trigger.card, "的额外目标");
				left--;
			} else break;
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
// 使用牌指定一名角色为目标后，比较其与你的本轮“权御”选择：
// 存在相同效果（≥1项）→得一张不计上限【杀】；
// 存在不同效果（仅1项相同或完全不同）→随机弃其一张牌，再对其发动一次“权御”。
// 无每回合次数限制、无唯一目标限制（多目标牌按目标逐个触发）。
async function tianenContent(event, trigger, player) {
	const target = trigger.target;
	const round = player.getStorage("suixiang_olquanyu_round", {}) || {};
	const playerChoices = round[player.playerid] || [];
	const targetChoices = round[target.playerid] || [];
	const sameNum = targetChoices.filter(link => playerChoices.includes(link)).length;
	if (sameNum >= 1) {
		// 存在相同：从牌堆获得一张不计入手牌上限的【杀】
		const card = get.cardPile("sha");
		if (card) {
			player.addSkill("suixiang_oltianen_effect");
			const next = player.gain(card, "gain2");
			next.gaintag.add("suixiang_oltianen_effect");
			await next;
		}
	}
	if (sameNum < 2) {
		// 存在不同：随机弃置其一张牌，然后对其发动一次“权御”
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

// ========== 势赵云与美化扩展兼容 ==========
// 随想录使用独立武将/技能 id，因此把动皮、千幻语音及无名美化特效分别映射到
// 原版势赵云 pot_zhaoyun，同时保留随想录自己的技能逻辑，避免原版技能重复触发。
function setupZhaoyunCompat() {
	// 十周年 UI / 皮肤切换：共享原版势赵云的动皮配置。
	if (window.decadeUI?.dynamicSkin) {
		const source = window.decadeUI.dynamicSkin.pot_zhaoyun || window.decadeUI.dynamicSkin.zhaoyun;
		if (source && !window.decadeUI.dynamicSkin["suixiang-shi_zhaoyun"]) {
			window.decadeUI.dynamicSkin["suixiang-shi_zhaoyun"] = source;
		}
	}
	// 千幻聆音：技能语音按原版技能查找皮肤语音；龙魂为武翊的衍生技能，
	// 共享武翊语音最符合原版势赵云的语音分组。
	if (lib.qhly_skinShare) {
		const share = lib.qhly_skinShare["suixiang-shi_zhaoyun"] || {};
		share.name ||= "pot_zhaoyun";
		share.skills ||= {};
		Object.assign(share.skills, {
			suixiang_wuyi: "potwuyi",
			suixiang_longhun: "potwuyi",
			suixiang_cuifeng: "potcuifeng",
		});
		lib.qhly_skinShare["suixiang-shi_zhaoyun"] = share;
	}

	// 无名美化特效是可选依赖。未安装或未开启势赵云特效时，随想录保持原有行为。
	if (!lib.config?.["extension_无名美化_shizhaoyun"] || !window.dcdAnim || !lib.skill) return;
	const dcdAnim = window.dcdAnim;
	if (typeof dcdAnim.loadSpine !== "function" || typeof dcdAnim.playSpine !== "function") return;
	const animations = {
		shan: { name: "../../../无名美化/animation/shizhaoyun/shan/SS_szy_shan" },
		huoSha: { name: "../../../无名美化/animation/shizhaoyun/sha/SS_szy_huosha" },
		leiSha: { name: "../../../无名美化/animation/shizhaoyun/sha/SS_szy_leisha" },
		sha: { name: "../../../无名美化/animation/shizhaoyun/sha/SS_szy_sha" },
		longlin: {
			loop: true,
			name: "../../../无名美化/animation/shizhaoyun/handCardArea/SS_szy_longlin",
		},
		kuangfangda: { name: "../../../无名美化/animation/shizhaoyun/head/SS_szy_kuangfangda" },
		kuanglizi: {
			loop: true,
			name: "../../../无名美化/animation/shizhaoyun/head/SS_szy_kuanglizi",
		},
	};
	const playAnimation = (animation, params = {}, player, storageKey) => {
		if (!animation) return;
		try {
			dcdAnim.loadSpine(animation.name, "skel", () => {
				try {
					const instance = dcdAnim.playSpine(animation, params);
					if (player && storageKey) {
						player.storage[storageKey] = instance;
					}
				} catch (e) {}
			});
		} catch (e) {}
	};
	const setShiFrame = player => {
		const frame = player?.querySelector?.(".camp-back");
		if (frame) frame.style.background = "linear-gradient(to top, #dba825, #ac9724)";
	};
	const playLonglin = player => {
		const effectApi = window.skinSwitch?.chukuangWorkerApi;
		if (!effectApi || typeof effectApi.playEffect2 !== "function" || typeof document === "undefined") return;
		const handcards = document.querySelector?.(".handcards");
		if (!handcards) return;
		const handWrap = document.querySelector?.(".hand-wrap");
		if (handWrap) handWrap.style.zIndex = 5;
		window._SS_szy_longlin = animations.longlin;
		try {
			effectApi.playEffect2(animations.longlin, { parent: handcards, scale: 0.5 });
		} catch (e) {}
	};
	const playWuyiAwakening = player => {
		if (!player || getWuyiLevel(player) < 4 || player._suixiang_zhaoyun_awakened) return;
		player._suixiang_zhaoyun_awakened = true;
		setShiFrame(player);
		playAnimation(animations.kuanglizi, { parent: player, scale: 0.82 }, player, "_suixiang_zhaoyun_kuanglizi");
		playLonglin(player);
	};
	const getCardAnimation = card => {
		if (!card) return null;
		const name = get.name(card) || card.name;
		const nature = get.nature(card);
		if (name === "shan") return animations.shan;
		if (name !== "sha") return null;
		if (nature === "fire") return animations.huoSha;
		if (nature === "thunder") return animations.leiSha;
		return animations.sha;
	};
	const playCardAnimation = (card, player) => {
		const animation = getCardAnimation(card);
		if (animation) playAnimation(animation, {}, player, "_suixiang_zhaoyun_card");
	};

	const wuyi = lib.skill.suixiang_wuyi;
	if (wuyi && !wuyi._suixiangZhaoyunCompat) {
		wuyi._suixiangZhaoyunCompat = true;
		const originInit = wuyi.init;
		const originFilter = wuyi.filter;
		const originContent = wuyi.content;
		if (typeof originInit === "function") {
			wuyi.init = function (player, skill) {
				const result = originInit.call(this, player, skill);
				playWuyiAwakening(player);
				return result;
			};
		}
		if (typeof originFilter === "function") {
			wuyi.filter = function (event, player, ...args) {
				if (getWuyiLevel(player) >= 4) {
					playAnimation(animations.kuangfangda, { parent: player, scale: 0.82 });
				}
				return originFilter.call(this, event, player, ...args);
			};
		}
		if (typeof originContent === "function") {
			wuyi.content = async function (event, trigger, player) {
				const result = await originContent.call(this, event, trigger, player);
				playWuyiAwakening(player);
				return result;
			};
		}
	}

	const longhun = lib.skill.suixiang_longhun;
	if (longhun && !longhun._suixiangZhaoyunCompat) {
		longhun._suixiangZhaoyunCompat = true;
		// 技能 content 会被无名杀的 StepCompiler 编译成独立函数，不能直接捕获
		// setupZhaoyunCompat 的局部变量。把闭包函数挂到技能对象上，供编译后的
		// content 通过 lib 访问，避免运行时出现“playCardAnimation 未定义”。
		longhun._suixiangZhaoyunPlayCardAnimation = playCardAnimation;
		longhun.subSkill ||= {};
		longhun.subSkill.zhaoyunAnim = {
			charlotte: true,
			silent: true,
			popup: false,
			trigger: { player: ["useCard", "respond"] },
			forced: true,
			filter(event) {
				return event.skill === "suixiang_longhun" && !!event.card;
			},
			content(event, trigger, player) {
				lib.skill.suixiang_longhun._suixiangZhaoyunPlayCardAnimation(trigger.card, player);
			},
		};
		longhun.group ||= [];
		if (!longhun.group.includes("suixiang_longhun_zhaoyunAnim")) {
			longhun.group.push("suixiang_longhun_zhaoyunAnim");
		}
	}
}

// 谋诸葛亮：共享原版诸葛亮的十周年动皮和千幻聆音皮肤库。
// 看破语音与千幻聆音皮肤映射到原版 sp_zhugeliang 的看破语音组。
function setupMouZhugeliangCompat() {
	if (window.decadeUI?.dynamicSkin) {
		const source =
			window.decadeUI.dynamicSkin.zhugeliang ||
			window.decadeUI.dynamicSkin.sp_zhugeliang ||
			window.decadeUI.dynamicSkin.sb_sp_zhugeliang;
		if (source && !window.decadeUI.dynamicSkin["suixiang-mou_zhugeliang"]) {
			window.decadeUI.dynamicSkin["suixiang-mou_zhugeliang"] = source;
		}
	}
	if (lib.qhly_skinShare) {
		const share = lib.qhly_skinShare["suixiang-mou_zhugeliang"] || {};
		share.name ||= "sp_zhugeliang";
		share.skills ||= {};
		share.skills.suixiang_mou_kanpo ||= "kanpo";
		lib.qhly_skinShare["suixiang-mou_zhugeliang"] = share;
	}
}

// 神曹丕：共享新杀神曹丕的十周年动皮与千幻聆音皮肤库。
function setupShenCaopiCompat() {
	if (window.decadeUI?.dynamicSkin) {
		const source = window.decadeUI.dynamicSkin.dc_shen_caopi;
		if (source && !window.decadeUI.dynamicSkin["suixiang-dc_shen_caopi"]) {
			window.decadeUI.dynamicSkin["suixiang-dc_shen_caopi"] = source;
		}
	}
	if (lib.qhly_skinShare) {
		lib.qhly_skinShare["suixiang-dc_shen_caopi"] = {
			name: "dc_shen_caopi",
			skills: {},
		};
	}
}

export const type = "extension";

export default function () {
	return {
		name: "随想录",
		content(config, pack) {
			// 技能内容会由 StepCompiler 重新编译，无法捕获扩展文件顶层的闭包函数。
			// 将被编译内容调用的工具函数挂到 lib 上，确保编译后的技能仍可访问。
			lib.suixiang_mou_huoji_setFlag = setMouHuojiFlag;
			lib.suixiang_mou_huoji_getDamageEvent = getMouHuojiDamageEvent;
			lib.suixiang_mou_kanpo_api = {
				getCardList: getMouKanpoCardList,
				consumeRecord: consumeMouKanpoRecord,
			};
			lib.suixiang_dc_keming_api = {
				getStealableSkills,
				getDamageTarget: getKemingDamageTarget,
				getCharacterPool: getKemingCharacterPool,
				getSurnameSkillOptions: getKemingSurnameSkillOptions,
				getTargetSkillOptions: getKemingTargetSkillOptions,
				getSkillChoiceDialog: getKemingSkillChoiceDialog,
			};
			lib.suixiang_mou_guanxing_api = {
				guanxingTag: MOU_GUANXING_TAG,
				xingTag: MOU_XING_TAG,
				isGuanxingCard: isMouGuanxingCard,
				getGuanxingCards: getMouGuanxingCards,
				isXingCard: isMouXingCard,
				getXingCards: getMouXingCards,
				getUsableCards: getMouGuanxingUsableCards,
				isDiscardEvent: isMouGuanxingDiscardEvent,
				extendUsePosition: extendMouUsePosition,
				extendDiscardPosition: extendMouDiscardPosition,
				fillCards: fillMouGuanxingCards,
				arrangeCards: arrangeMouGuanxingCards,
				removeCards: removeMouGuanxingCards,
				deckState: { owner: null, cards: [], ready: false },
			};
			lib.translate[MOU_GUANXING_TAG] = "观星";
			lib.translate[MOU_XING_TAG] = "星";
			setupMouGuanxingDeckCompat();
			setupMouZhugeliangCardCompat();
			// 立即尝试（美化扩展已加载时生效），并在游戏就绪后兜底（美化扩展后加载时生效）
			setupShenMachaoCompat();
			setupSunquanCompat();
			setupZhaoyunCompat();
			setupMouZhugeliangCompat();
			setupShenCaopiCompat();
			lib.arenaReady.push(setupShenMachaoCompat);
			lib.arenaReady.push(setupSunquanCompat);
			lib.arenaReady.push(setupZhaoyunCompat);
			lib.arenaReady.push(setupMouZhugeliangCompat);
			lib.arenaReady.push(setupShenCaopiCompat);
			lib.arenaReady.push(setupMouZhugeliangCardCompat);
			lib.arenaReady.push(setupMouGuanxingPlayerTopCardsCompat);
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
					// 势赵云：原画、阵亡语音与技能语音由用户提供的 PR 包接入。
					"suixiang-shi_zhaoyun": {
						sex: "male",
						group: "shu",
						hp: 4,
						skills: ["suixiang_wuyi", "suixiang_cuifeng"],
						names: "赵|云",
						img: "extension/随想录/image/character/suixiang-shi_zhaoyun.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-shi_zhaoyun.mp3"],
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
					// 势力与OL魔孙权一致为"魔"（devil）；立绘、阵亡语音为复制进扩展包的原版资源。
					// 技能：权御/天恩/乾纲/入魔全部实装（重构版，语音/选单/标记与原版一致）。
					// 技能语音已按技能id备于 audio/skill/suixiang_olquanyu* 等。
					"suixiang-dm_sunquan": {
						sex: "male",
						group: "devil",
						hp: 4,
						skills: ["suixiang_olquanyu", "suixiang_oltianen", "suixiang_olqiangang"],
						names: "孙|权",
						img: "extension/随想录/image/character/suixiang-dm_sunquan.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-dm_sunquan.mp3"],
					},
					// 谋诸葛亮：沿用本体 sb_sp_zhugeliang 的男/蜀/3 设定，接入看破、火计及其衍生技。
					"suixiang-mou_zhugeliang": {
						sex: "male",
						group: "shu",
						hp: 3,
						maxHp: 3,
						skills: ["suixiang_mou_kanpo", "suixiang_mou_huoji"],
						names: "诸葛|亮",
						clans: ["琅琊诸葛氏"],
						img: "extension/随想录/image/character/suixiang-mou_zhugeliang.jpg",
						dieAudios: ["ext:随想录/audio/die/suixiang-mou_zhugeliang.mp3"],
					},
					// 神曹丕：沿用新杀神曹丕的男/神/4体力设定与国战魏势力，添加〖阴鸷〗和〖刻名〗。
					"suixiang-dc_shen_caopi": {
						sex: "male",
						group: "shen",
						hp: 4,
						maxHp: 4,
						groupInGuozhan: "wei",
						skills: ["suixiang_dc_yinzhi", "suixiang_dc_keming"],
						names: "曹|丕",
						img: "extension/随想录/image/character/suixiang-dc_shen_caopi.jpg",
					},
				},
				translate: {
					"suixiang-shi_xiaoqiao": "势 小乔",
					"suixiang-shi_zhaoyun": "势 赵云",
					"suixiang-mb_shen_machao": "神 马超",
					"suixiang-dm_sunquan": "魔 孙权",
					"suixiang-mou_zhugeliang": "谋 诸葛亮",
					"suixiang-dc_shen_caopi": "神 曹丕",
				},
				characterTitle: {
					"suixiang-shi_xiaoqiao": "衷音慰湟",
					"suixiang-mb_shen_machao": "势震九天",
					"suixiang-dm_sunquan": "隳堕的英谋",
					"suixiang-dc_shen_caopi": "月晦书轮回",
				},
			},
			skill: {
				skill: {
					// ========== 火计（使命技） ==========
					suixiang_mou_huoji: {
						audio: "ext:随想录/audio/skill:3",
						dutySkill: true,
						onremove(player) {
							for (const name of [
								"suixiang_mou_huoji_used",
								"suixiang_mou_huoji_extra",
								"suixiang_mou_huoji_extra_used",
							]) {
								lib.suixiang_mou_huoji_setFlag(player, name, 0);
							}
						},
						derivation: ["suixiang_mou_guanxing", "suixiang_mou_kongcheng"],
						group: [
							"suixiang_mou_huoji_fire",
							"suixiang_mou_huoji_track",
							"suixiang_mou_huoji_achieve",
							"suixiang_mou_huoji_fail",
							"suixiang_mou_huoji_phase_begin",
							"suixiang_mou_huoji_phase_after",
						],
						subSkill: {
							fire: {
								audio: "ext:随想录/audio/skill/suixiang_mou_huoji1.mp3",
								enable: "phaseUse",
								filter(event, player) {
									if (player.storage.suixiang_mou_huoji_failed) return false;
									const used = Number(player.storage.suixiang_mou_huoji_used) || 0;
									const extra = Number(player.storage.suixiang_mou_huoji_extra) || 0;
									return used === 0 || extra > 0;
								},
								filterTarget: (card, player, target) => target !== player,
								selectTarget: 1,
								prompt(event, player) {
									const extra = Number(player.storage.suixiang_mou_huoji_extra) || 0;
									const extraCount = Number(player.storage.suixiang_mou_huoji_extra_used) || 0;
									return extra > 0
										? `火计：选择一名其他角色，对其与其势力相同的其他角色各造成${2 + extraCount}点火焰伤害（剩余额外发动${extra}次）`
										: "选择一名其他角色，对其与其势力相同的其他角色各造成1点火焰伤害";
								},
								line: "fire",
								async content(event, trigger, player) {
									const used = Number(player.storage.suixiang_mou_huoji_used) || 0;
									let extra = Number(player.storage.suixiang_mou_huoji_extra) || 0;
									let extraCount = Number(player.storage.suixiang_mou_huoji_extra_used) || 0;
									const isExtra = used > 0;
									if (isExtra) {
										if (extra <= 0) return;
										extra--;
										extraCount++;
									}
									lib.suixiang_mou_huoji_setFlag(player, "suixiang_mou_huoji_used", used + 1);
									lib.suixiang_mou_huoji_setFlag(player, "suixiang_mou_huoji_extra", extra);
									lib.suixiang_mou_huoji_setFlag(player, "suixiang_mou_huoji_extra_used", extraCount);
									const target = event.targets?.[0] ?? event.target;
									if (!target || target === player || !target.isIn() || !player.isIn()) return;

									const batch = { player };
									const targets = game.filterPlayer(current => current !== player && current.group === target.group);
									player.line(targets, "fire");
									if (targets.length) await game.delayx();
									for (const current of targets) {
										if (!current.isIn()) continue;
										const damage = current.damage({ source: player, num: 1 + extraCount, nature: "fire" });
										if (damage) damage.suixiang_mou_huoji_batch = batch;
										await damage;
									}
								},
								ai: {
									order: 7,
									fireAttack: true,
									result: {
										target(player, target) {
											return game
												.filterPlayer(current => current !== player && current.group === target.group)
												.reduce((sum, current) => sum + get.damageEffect(current, player, player, "fire"), 0);
										},
									},
								},
							},
							track: {
								charlotte: true,
								trigger: { global: "dying" },
								forced: true,
								popup: false,
								filter(event) {
									const damage = lib.suixiang_mou_huoji_getDamageEvent(event);
									return !!damage?.hasNature?.("fire");
								},
								async content(event, trigger, player) {
									lib.suixiang_mou_huoji_setFlag(player, "suixiang_mou_huoji_fire_dying", true);
									const damage = lib.suixiang_mou_huoji_getDamageEvent(trigger);
									const batch = damage?.suixiang_mou_huoji_batch;
									if (!batch || batch.player !== player || !player.isIn()) return;
									if (batch.suixiang_mou_huoji_extra_granted) return;
									batch.suixiang_mou_huoji_extra_granted = true;
									const extra = Number(player.storage.suixiang_mou_huoji_extra) || 0;
									lib.suixiang_mou_huoji_setFlag(player, "suixiang_mou_huoji_extra", extra + 1);
								},
							},
							achieve: {
								audio: "ext:随想录/audio/skill/suixiang_mou_huoji2.mp3",
								trigger: { player: "phaseZhunbeiBegin" },
								forced: true,
								locked: false,
								filter(event, player) {
									return player.storage.suixiang_mou_huoji_fire_dying === true;
								},
								async content(event, trigger, player) {
									player.awakenSkill("suixiang_mou_huoji");
									await player.changeSkills(["suixiang_mou_guanxing", "suixiang_mou_kongcheng"], ["suixiang_mou_huoji"]);
									await lib.suixiang_mou_guanxing_api.fillCards(player);
									game.log(player, "成功完成使命");
								},
							},
							fail: {
								audio: "ext:随想录/audio/skill/suixiang_mou_huoji3.mp3",
								trigger: { player: "dying" },
								forced: true,
								locked: false,
								async content(event, trigger, player) {
									lib.suixiang_mou_huoji_setFlag(player, "suixiang_mou_huoji_failed", true);
									await player.recoverTo(player.maxHp);
									player.awakenSkill("suixiang_mou_huoji");
									game.log(player, "使命失败");
								},
							},
							phase_begin: {
								trigger: { player: "phaseUseBegin" },
								forced: true,
								silent: true,
								charlotte: true,
								content(event, trigger, player) {
									for (const name of [
										"suixiang_mou_huoji_used",
										"suixiang_mou_huoji_extra",
										"suixiang_mou_huoji_extra_used",
									]) {
										lib.suixiang_mou_huoji_setFlag(player, name, 0);
									}
								},
							},
							phase_after: {
								trigger: { player: "phaseUseAfter" },
								forced: true,
								silent: true,
								charlotte: true,
								content(event, trigger, player) {
									for (const name of [
										"suixiang_mou_huoji_used",
										"suixiang_mou_huoji_extra",
										"suixiang_mou_huoji_extra_used",
									]) {
										lib.suixiang_mou_huoji_setFlag(player, name, 0);
									}
								},
							},
						},
					},
					suixiang_mou_guanxing: {
						audio: "ext:随想录/audio/skill:2",
						trigger: { player: "enterGame", global: "phaseZhunbeiBegin" },
						forced: true,
						locked: true,
						mark: true,
						marktext: "星",
						onremove(player) {
							const topCards = lib.suixiang_mou_guanxing_api.getGuanxingCards(player);
							const stars = lib.suixiang_mou_guanxing_api.getXingCards(player);
							const state = lib.suixiang_mou_guanxing_api.deckState;
							state.cards = [];
							state.ready = false;
							if (state.owner === player) state.owner = null;
							for (const card of topCards) card.removeGaintag?.(lib.suixiang_mou_guanxing_api.guanxingTag);
							if (topCards.length) game.cardsGotoPile(topCards.slice().reverse(), "insert");
							if (stars.length) player.loseToDiscardpile({ cards: stars, position: ui.discardPile, log: false, animate: false });
						},
						async content(event, trigger, player) {
							await lib.suixiang_mou_guanxing_api.fillCards(player);
							if (trigger.name === "phaseZhunbei") {
								await lib.suixiang_mou_guanxing_api.arrangeCards(player);
							}
						},
						group: ["suixiang_mou_guanxing_replenish", "suixiang_mou_guanxing_hand", "suixiang_mou_guanxing_cards", "suixiang_mou_guanxing_star"],
						subSkill: {
							replenish: {
								charlotte: true,
								trigger: { player: "loseAfter" },
								forced: true,
								silent: true,
								filter(event, player) {
									if (player._suixiang_mou_guanxing_arranging || !event.ss?.length) return false;
									const lost = event.getl?.(player) || event;
									const tagMap = lost.gaintag_map || {};
									return (lost.ss || []).some(card => tagMap[card.cardid]?.includes(lib.suixiang_mou_guanxing_api.guanxingTag) || card.hasGaintag?.(lib.suixiang_mou_guanxing_api.guanxingTag));
								},
								async content(event, trigger, player) {
									const lost = trigger.getl?.(player) || trigger;
									const tagMap = lost.gaintag_map || {};
									const cards = (lost.ss || []).filter(card => tagMap[card.cardid]?.includes(lib.suixiang_mou_guanxing_api.guanxingTag) || card.hasGaintag?.(lib.suixiang_mou_guanxing_api.guanxingTag));
									lib.suixiang_mou_guanxing_api.removeCards(player, cards);
									await lib.suixiang_mou_guanxing_api.fillCards(player);
								},
							},
							hand: {
								charlotte: true,
								trigger: { player: ["enterGame", "gainAfter"] },
								forced: true,
								silent: true,
								filter(event, player) {
									return player.countCards("h") > 0;
								},
								async content(event, trigger, player) {
									const cards = player.getCards("h");
									if (!cards.length) return;
									await player.discard(cards);
								},
							},
							cards: {
								charlotte: true,
								forced: true,
								silent: true,
								trigger: { player: ["chooseToUseBegin", "chooseToRespondBegin", "chooseToDiscardBegin"] },
								filter(event, player) {
									if (event.name === "chooseToUse" || event.name === "chooseToRespond") {
										return lib.suixiang_mou_guanxing_api.getUsableCards(player).length > 0 && String(event.position || "hs").includes("h");
									}
									return lib.suixiang_mou_guanxing_api.getUsableCards(player).length > 0 && lib.suixiang_mou_guanxing_api.isDiscardEvent(event);
								},
								content(event, trigger, player) {
									if (trigger.name === "chooseToUse" || trigger.name === "chooseToRespond") {
										lib.suixiang_mou_guanxing_api.extendUsePosition(trigger, player);
									} else {
										lib.suixiang_mou_guanxing_api.extendDiscardPosition(trigger, player);
									}
								},
							},
							star: {
								charlotte: true,
								forced: true,
								silent: true,
								firstDo: true,
								trigger: { player: "loseAfter" },
								filter(event, player) {
									if (event.type !== "discard" || event.position !== ui.discardPile) return false;
									const lost = event.getl?.(player) || event;
									return (lost.hs || []).some(card => card.parentNode === ui.discardPile);
								},
								async content(event, trigger, player) {
									const lost = trigger.getl?.(player) || trigger;
									const cards = (lost.hs || []).filter(card => card.parentNode === ui.discardPile);
									if (!cards.length) return;
					for (const card of cards) {
						card.removeGaintag?.(lib.suixiang_mou_guanxing_api.guanxingTag);
						card.removeGaintag?.(lib.suixiang_mou_guanxing_api.xingTag);
					}
									player.directgains(cards, undefined, lib.suixiang_mou_guanxing_api.xingTag);
									player.markSkill("suixiang_mou_guanxing");
									game.log(player, "将", cards, "置为", "#y星");
								},
							},
						},
						intro: {
							markcount(storage, player) {
								return lib.suixiang_mou_guanxing_api.getXingCards(player).length;
							},
							mark(dialog, content, player) {
								const stars = lib.suixiang_mou_guanxing_api.getXingCards(player);
								const topCards = lib.suixiang_mou_guanxing_api.getGuanxingCards(player);
								if (stars.length) {
									dialog.addText(`“星”共${stars.length}张`);
									dialog.addAuto(stars);
								} else {
									dialog.addText("当前没有“星”");
								}
								if (player.isUnderControl(true)) {
									if (topCards.length) {
										dialog.addText("牌堆顶的牌：");
										dialog.addAuto(topCards);
									}
								} else {
									dialog.addText(`牌堆顶有${topCards.length}张牌`);
								}
							},
						},
						mod: {
							maxHandcard() {
								return 0;
							},
							cardUsable(card) {
								if (lib.suixiang_mou_guanxing_api.isGuanxingCard(card)) return Infinity;
							},
							targetInRange(card) {
								if (lib.suixiang_mou_guanxing_api.isGuanxingCard(card)) return true;
							},
						},
						ai: {
							guanxing: true,
						},
					},
					suixiang_mou_kongcheng: {
						audio: "ext:随想录/audio/skill:2",
						locked: true,
						mod: {
							targetEnabled(card, player, target) {
								if (target.countCards("h") === 0 && (card.name === "sha" || card.name === "juedou")) {
									return false;
								}
							},
						},
						trigger: { player: "damageBegin1" },
						filter(event, player) {
							return event.num > 0 && player.countCards("h") === 0 && lib.suixiang_mou_guanxing_api.getXingCards(player).length >= 3;
						},
						async content(event, trigger, player) {
							const result = await player
								.chooseBool({
									prompt: "空城：是否弃置三张“星”，令此次伤害无效？",
									choice: true,
								})
								.forResult();
							if (!result?.bool) return;
							const payment = await player
								.chooseCard({
									position: "x",
									selectCard: 3,
									forced: true,
									prompt: "空城：选择三张“星”置入弃牌堆",
									filterCard(card) {
									return lib.suixiang_mou_guanxing_api.isXingCard(card);
									},
								})
								.forResult();
							if (!payment?.bool || payment.cards?.length !== 3) return;
							await player.loseToDiscardpile({ cards: payment.cards, log: false, animate: false });
							trigger.cancel();
						},
						ai: {
							noh: true,
							skillTagFilter(player, tag) {
								return tag === "noh" && player.countCards("h") === 0;
							},
						},
					},
					// ========== 看破（谋诸葛亮加强版） ==========
					suixiang_mou_kanpo: {
						audio: "ext:随想录/audio/skill:2",
						mark: true,
						marktext: "破",
						init(player) {
							player.storage.suixiang_mou_kanpo = [];
						},
						onremove(player) {
							delete player.storage.suixiang_mou_kanpo;
						},
						intro: {
							markcount(storage) {
								return Array.isArray(storage) ? storage.length : 0;
							},
							mark(dialog, content, player) {
								const names = player.getStorage("suixiang_mou_kanpo");
								dialog.addText(`当前记录${names.length}项牌名`);
								if (player.isUnderControl(true) && names.length) {
									dialog.addText("当前记录的牌名：");
									dialog.addSmall([names.map(name => [get.type(name), "", name]), "vcard"]);
								}
							},
						},
						group: ["suixiang_mou_kanpo_init", "suixiang_mou_kanpo_use"],
						subSkill: {
							init: {
								charlotte: true,
								trigger: { global: "gameStart" },
								forced: true,
								async content(event, trigger, player) {
									const list = lib.suixiang_mou_kanpo_api.getCardList();
									if (!list.length) {
										player.storage.suixiang_mou_kanpo = [];
										player.markSkill("suixiang_mou_kanpo");
										return;
									}
									const setupControls = () => {
										const event = get.event();
										const updateCounter = (button, count) => {
											let counterNode = button.querySelector(".caption");
											if (count > 0) {
												if (counterNode) counterNode.childNodes[0].innerHTML = `×${count}`;
												else {
													counterNode = ui.create.caption(`<span style="font-size:24px; font-family:xinwei; text-shadow:#FFF 0 0 4px, #FFF 0 0 4px, rgba(74,29,1,1) 0 0 3px;">×${count}</span>`, button);
													counterNode.style.right = "5px";
													counterNode.style.bottom = "2px";
												}
											} else if (counterNode) counterNode.childNodes[0].innerHTML = "";
										};
										const controls = [(link) => {
											const evt = get.event();
											if (!evt?.dialog?.buttons) return;
											if (link === "撤销上一项") {
												const button = ui.selected.buttons.pop();
												if (button) {
													const count = ui.selected.buttons.filter(item => item === button).length;
													if (count) button.classList.add("selected");
													else button.classList.remove("selected");
													updateCounter(button, count);
												}
											} else if (link === "清除选择") {
												for (const button of evt.dialog.buttons) {
													button.classList.remove("selectable");
													button.classList.remove("selected");
													updateCounter(button, 0);
												}
												ui.selected.buttons.length = 0;
											}
											game.check();
										}];
										const control = ui.create.control(controls.concat(["撤销上一项", "清除选择"]));
										// 将辅助按钮放到确认按钮上方，避免与原生确认栏重叠。
										control.classList.add("suixiang-mou-kanpo-controls");
										control.style.top = "-56px";
										control.style.zIndex = "6";
										event.controls = [control];
									};
									const closeControls = () => {
										const event = get.event();
										if (event?.controls) event.controls[0].close();
									};
									if (event.isMine()) setupControls();
									else if (event.isOnline()) event.player.send(setupControls);

									const result = await player
										.chooseButton({
											createDialog: ["看破：选择0至4项记录（可重复）", [list, "vcard"]],
											selectButton: [0, 4],
											forced: false,
											ai(button) {
												const name = button.link[2];
												const score = { wuxie: 6, sha: 5.8, tao: 5.5, shan: 5.2, jiu: 4.7, wuzhong: 4.5 };
												return score[name] || 2;
											},
										})
										.set("maxCount", 4)
										.set("custom", {
											add: {
												confirm(bool) {
													const event = get.event();
													const owner = event?.controls ? event : event?.parent;
													if (owner?.controls) owner.controls.forEach(control => control.close());
													if (ui.confirm) ui.confirm.close();
													game.uncheck();
												},
												button() {
													if (ui.selected.buttons.length) return;
													const event = get.event();
													for (const button of event.dialog?.buttons || []) {
														const counterNode = button.querySelector(".caption");
														if (counterNode) counterNode.childNodes[0].innerHTML = "";
													}
													const parent = event.parent;
													if (parent.controls) parent.controls[0].classList.add("disabled");
												},
											},
											replace: {
												button(button) {
													const event = get.event();
													if (!event.isMine() || !button.classList.contains("selectable")) return;
													if (ui.selected.buttons.length >= event.maxCount) return false;
													button.classList.add("selected");
													ui.selected.buttons.push(button);
													const count = ui.selected.buttons.filter(item => item === button).length;
													let counterNode = button.querySelector(".caption");
													if (counterNode) counterNode.childNodes[0].innerHTML = `×${count}`;
													else {
														counterNode = ui.create.caption(`<span style="font-size:24px; font-family:xinwei; text-shadow:#FFF 0 0 4px, #FFF 0 0 4px, rgba(74,29,1,1) 0 0 3px;">×${count}</span>`, button);
														counterNode.style.right = "5px";
														counterNode.style.bottom = "2px";
													}
													const parent = event.parent;
													if (parent.controls) parent.controls[0].classList.remove("disabled");
													game.check();
												},
											},
									})
										.forResult();
									if (result.bool) {
										player.storage.suixiang_mou_kanpo = (result.links || []).map(link => link[2]);
									} else {
										player.storage.suixiang_mou_kanpo = [];
										if (event.isMine()) closeControls();
										else if (event.isOnline()) event.player.send(closeControls);
									}
									player.markSkill("suixiang_mou_kanpo");
								},
							},
							use: {
								audio: "suixiang_mou_kanpo",
								trigger: { global: "useCard" },
								filter(event, player) {
									const name = event.card && get.name(event.card, event.player);
									return event.player !== player && !!name && player.storage.suixiang_mou_kanpo?.includes(name);
								},
								prompt2(event) {
									const name = event.card && (get.name(event.card, event.player) || event.card.name);
									return `移去一项${get.translation(name)}记录，令${get.translation(event.card)}无效并摸一张牌`;
								},
								check(event, player) {
									const name = event.card && (get.name(event.card, event.player) || event.card.name);
									if (name === "wuxie" || name === "shan") return get.attitude(player, event.player) < -1;
									return (event.targets || []).reduce((sum, target) => sum + get.effect(target, event.card, event.player, player), 0) < 0;
								},
								logTarget: "player",
								async content(event, trigger, player) {
									const name = get.name(trigger.card, trigger.player) || trigger.card.name;
									const records = player.storage.suixiang_mou_kanpo;
									if (!lib.suixiang_mou_kanpo_api.consumeRecord(records, name)) return;
									player.markSkill("suixiang_mou_kanpo");
									if (Array.isArray(trigger.targets)) trigger.targets.length = 0;
									trigger.all_excluded = true;
									if (player.storage.suixiang_mou_huoji_failed && trigger.player?.isIn()) {
										const user = trigger.player;
										const skills = user.getSkills("invisible", false, false).filter(skill => lib.skill[skill] && !get.is.locked(skill, user));
										for (const skill of skills) {
											// 失效一轮：下一次全局 roundStart 时恢复。
											user.tempBanSkill(skill, "roundStart");
										}
										await user.damage({ num: 1, nosource: true });
									}
									await player.draw({ num: 1 });
									if (!player.isIn()) return;

									const list = lib.suixiang_mou_kanpo_api.getCardList(name);
									if (!list.length) return;
									const { bool } = await player
										.chooseBool({ prompt: `看破：是否记录一个不同于${get.translation(name)}的新牌名？`, choice: true })
										.forResult();
									if (!bool) return;
									const result = await player
										.chooseButton({
											createDialog: [`看破：选择一个不同于${get.translation(name)}的牌名`, [list, "vcard"]],
											selectButton: 1,
											forced: true,
											ai(button) {
												const score = { wuxie: 6, sha: 5.8, tao: 5.5, shan: 5.2, jiu: 4.7, wuzhong: 4.5 };
												return score[button.link[2]] || 2;
											},
										})
										.forResult();
									const newName = result.links?.[0]?.[2];
									if (!result.bool || !newName || newName === name) return;
									records.push(newName);
									player.markSkill("suixiang_mou_kanpo");
								},
							},
						},
					},
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
					suixiang_longhun: {
						audio: "ext:随想录/audio/skill:2",
						mod: {
							aiOrder(player, card, num) {
								if (num <= 0 || !player.isPhaseUsing(true) || player.needsToDiscard() < 2) {
									return num;
								}
								if (_status.event.skill == "suixiang_longhun" && card.name == "tao") {
									return num + 3.6;
								}
								let suit = get.suit(card, player);
								if (suit === "heart") {
									return num - 3.6;
								}
							},
							aiValue(player, card, num) {
								if (num <= 0) {
									return num;
								}
								let suit = get.suit(card, player);
								if (suit === "heart") {
									return num + 3.6;
								} else if (suit === "club") {
									return num + 1;
								} else if (suit === "spade") {
									return num + 1.8;
								}
							},
							aiUseful(player, card, num) {
								if (num <= 0) {
									return num;
								}
								let suit = get.suit(card, player);
								if (suit === "heart") {
									return num + 3;
								} else if (suit === "club") {
									return num + 1;
								} else if (suit === "spade") {
									return num + 1;
								}
							},
						},
						locked: false,
						enable: ["chooseToUse", "chooseToRespond"],
						prompt: "将♦牌当做杀，♥牌当做桃，♣牌当做闪，♠牌当做无懈可击使用或打出",
						viewAs(cards, player) {
							if (cards.length) {
								const suit = get.suit(cards[0], player);
								let name = { diamond: "sha", club: "shan", heart: "tao", spade: "wuxie" }[suit];
								if (name) {
									return { name, nature: name == "sha" ? "fire" : undefined };
								}
							}
							return null;
						},
						filter(event, player) {
							const filter = event.filterCard;
							const map = { sha: "diamond", shan: "club", tao: "heart", wuxie: "spade" };
							for (let name of Object.keys(map)) {
								if (filter(get.autoViewAs({ name, nature: name == "sha" ? "fire" : undefined }, "unsure"), player, event)) {
									if (player.countCards("hes", { suit: map[name] })) {
										return true;
									}
								}
							}
							return false;
						},
						selectCard: [1, 2],
						position: "hes",
						complexCard: true,
						filterCard(card, player, event) {
							if (ui.selected.cards.length) {
								return get.suit(card, player) == get.suit(ui.selected.cards[0], player);
							}
							event = event || get.event();
							const filter = event._backup.filterCard,
								suit = get.suit(card, player);
							const name = { diamond: "sha", club: "shan", heart: "tao", spade: "wuxie" }[suit];
							if (name) {
								return filter(get.autoViewAs({ name, nature: name == "sha" ? "fire" : undefined }, "unsure"), player, event);
							}
							return false;
						},
						getValue(event) {
							const player = event.player;
							const list = {};
							for (let card of player.getCards("hes")) {
								const suit = get.suit(card, player);
								if (!list[suit]?.length) {
									list[suit] = [];
								}
								list[suit].add(card);
							}
							for (let i in list) {
								list[i].sort((a, b) => get.value(b) - get.value(a));
							}
							return list;
						},
						getCheck(event) {
							const player = event.player,
								map = { sha: "diamond", shan: "club", tao: "heart", wuxie: "spade" };
							event.valueList ??= lib.skill.suixiang_longhun.getValue(event);
							let suit = null,
								double = true,
								max = 0;
							for (let name in map) {
								let useCard = get.autoViewAs({ name, nature: name == "sha" ? "fire" : undefined }, "unsure");
								if (!event._backup.filterCard(useCard, player, event)) {
									continue;
								} else if (!event.valueList[map[name]]?.length) {
									continue;
								}
								let temp = name == "wuxie" ? 3 : get.order(useCard, player);
								if (temp <= max) {
									continue;
								}
								suit = map[name];
								max = temp;
							}
							if (suit) {
								if (event.name != "chooseToUse") {
									double = false;
								} else if (suit == "club") {
									const evt = event.getParent();
									if (evt?.player && evt?.player?.isIn()) {
										double = get.effect(evt.player, { name: "guohe_copy2" }, evt.player, player) > 0;
									}
								} else if (suit == "heart") {
									if (event.type == "dying" && event.dying.hp < 0) {
										double = false;
									}
									if (player.countCards("hse", i => get.tag(i, "save") || get.suit(i, player) == "heart") < 3) {
										double = false;
									} else {
										double = player.isPhaseUsing(true) ? player.needsToDiscard() > 0 : player.hp > -1;
									}
								} else if (suit == "spade") {
									if (event.getParent(4).name == "phaseJudge") {
										double = false;
									}
								} else if (suit == "diamond") {
									const card = get.autoViewAs({ name: "sha", nature: "fire" }, "unsure");
									const filterTarget = event._backup.filterTarget,
										range = get.select(event._backup.selectTarget);
									game.checkMod(card, player, range, "selectTarget", player);
									const targets = game.filterPlayer(current => {
										if (typeof filterTarget == "function") {
											return filterTarget(card, player, current);
										} else if (typeof filterTarget == "boolean") {
											return filterTarget;
										}
										return false;
									});
									if (range[1] < 0 || range[0] == targets.length) {
										double = targets.reduce((eff, target) => eff + get.effect(target, card, player, player), 0) > 0;
									}
									double = targets.some(target => get.effect(target, card, player, player) > 0);
								}
							}
							return [suit, double];
						},
						check(card) {
							const event = get.event(),
								player = get.player(),
								cards = ui.selected.cards?.slice();
							event.getCheck ??= lib.skill.suixiang_longhun.getCheck(event);
							const [suit, double] = event.getCheck;
							if (!suit) {
								return 0;
							} else if (cards?.length) {
								if (!double) {
									return 0;
								} else if (suit == "heart") {
									if (event.getTrigger()?.player && event.getTrigger()?.player != player) {
										if (get.attitude(player, event.getTrigger().player) < 0) {
											return 0;
										} else if (
											(function () {
												return get.value({ name: "tao" }, player) > get.value(cards.concat([card]), player);
											})()
										) {
											return 0;
										}
									}
								} else if (suit == "spade") {
									if (event.getTrigger()?.card?.cards?.length) {
										const gainCardsValue = get.value(event.getTrigger().card.cards, player),
											useCardValue = get.value(cards.concat([card]), player);
										if (gainCardsValue < useCardValue) {
											return 0;
										}
									}
								}
							}
							return event.valueList[suit].indexOf(card) + 1;
						},
						hiddenCard(player, name) {
							if (_status.connectMode && name == "wuxie" && player.countCards("hes") > 0) {
								return true;
							}
							let suit = { sha: "diamond", shan: "club", tao: "heart", wuxie: "spade" };
							return name && name in suit && player.countCards("hes", { suit: suit[name] }) > 0;
						},
						ai: {
							save: true,
							respondSha: true,
							respondShan: true,
							skillTagFilter(player, tag) {
								let name;
								switch (tag) {
									case "respondSha":
										name = "diamond";
										break;
									case "respondShan":
										name = "club";
										break;
									case "save":
										name = "heart";
										break;
								}
								if (!player.countCards("hes", { suit: name })) {
									return false;
								}
							},
							order(item, player) {
								const event = get.event();
								if (player && event.name == "chooseToUse") {
									let max = 0;
									const map = { sha: "diamond", shan: "club", tao: "heart" };
									for (let name in map) {
										let card = get.autoViewAs({ name: name, nature: name == "sha" ? "fire" : undefined }, "unsure");
										if (!event.filterCard(card, player, event)) {
											continue;
										} else if (!player.countCards("hes", i => get.suit(i, player) == map[name])) {
											continue;
										}
										let temp = name == "wuxie" ? 3 : get.order(card, player);
										if (temp > max) {
											max = temp;
										}
									}
									if (max > 0) {
										return max * 1.2;
									}
								}
								return 1;
							},
						},
						group: ["suixiang_longhun_effect"],
						subSkill: {
							effect: {
								trigger: {
									player: "useCard",
								},
								forced: true,
								popup: false,
								filter(event) {
									return event.skill == "suixiang_longhun" && event.cards && event.cards.length == 2;
								},
								async content(event, trigger, player) {
									switch (trigger.card.name) {
										case "tao":
											await game.doAsyncInOrder(trigger.targets, async target => await target.gainMaxHp());
											break;
										case "sha":
											trigger.effectCount += 2;
											break;
										case "shan":
											if (trigger.respondTo && trigger.respondTo[0]?.isIn()) {
												trigger.respondTo[0].randomDiscard(2, "he");
											}
											break;
										case "wuxie":
											trigger.card.storage ??= {};
											trigger.card.storage.nowuxie = true;
											trigger.directHit.addArray(game.players);
											player
												.when({ global: "eventNeutralized" })
												.filter(evt => {
													if (evt.type != "card" && evt.name != "_wuxie") {
														return false;
													}
													return evt._neutralize_event.card == trigger.card;
												})
												.then(async (event, trigger, player) => {
													let cards = trigger.cards.filterInD("od");
													if (cards.length) {
														await player.gain(cards, "gain2");
													}
												});
											break;
									}
								},
							},
						},
					},
					suixiang_wuyi: {
						audio: "ext:随想录/audio/skill:2",
						logAudio(_event, player) {
							const level = Math.max(1, Math.min(4, getWuyiLevel(player)));
							return `ext:随想录/audio/skill/suixiang_wuyi${level}.mp3`;
						},
						persevereSkill: true,
						forced: true,
						silent: true,
						popup: false,
						mark: true,
						marktext: "翊",
						init(player, skill) {
							if (!Array.isArray(player.storage[skill])) {
								player.storage[skill] = [];
							}
							refreshCuifengUnlocks(player);
							if (getWuyiLevel(player) >= 2) {
								player.addAdditionalSkill(skill, "suixiang_longhun");
							}
						},
						onremove(player, skill) {
							player.removeAdditionalSkill(skill, "suixiang_longhun");
							for (const target of game.filterPlayer((current) => current !== player)) {
								target.removeSkill("suixiang_wuyi_block");
							}
						},
						trigger: {
							player: ["useCardAfter", "respondAfter"],
						},
						filter(event, player) {
							if (!event.card || get.type(event.card, null, player) !== "basic") return false;
							const name = get.name(event.card, player) || event.card.name;
							return !!name && !getWuyiNames(player).includes(name);
						},
						async content(event, trigger, player) {
							const name = get.name(trigger.card, player) || trigger.card.name;
							if (!name) return;
							if (recordWuyiName(player, name)) {
								game.trySkillAudio?.("suixiang_wuyi", player, true, null, null, [trigger, player]);
								await applyWuyiProgress(player);
							}
						},
						mod: {
							targetInRange(card, player) {
								if (getWuyiLevel(player) >= 1) {
									return true;
								}
							},
							cardUsable(card, player) {
								if (getWuyiLevel(player) >= 1) {
									return Infinity;
								}
							},
						},
						group: ["suixiang_wuyi_phase", "suixiang_wuyi_hand"],
						intro: {
							content(storage, player) {
								const names = getWuyiNames(player);
								const active = [
									[1, "使用牌无距离和次数限制"],
									[2, "视为拥有〖龙魂〗"],
									[3, "你的回合内其他角色的非持恒技能失效"],
									[4, "手牌数始终为4"],
								]
									.filter(([level]) => names.length >= level)
									.map(([, text]) => text);
								return "本局已使用或打出" + names.length + "种基本牌牌名：" + (names.map((name) => get.translation(name)).join("、") || "无") + "<br>" + (active.join("<br>") || "尚未达到任何档位");
							},
						},
						subSkill: {
							phase: {
								charlotte: true,
								persevereSkill: true,
								sourceSkill: "suixiang_wuyi",
								trigger: { player: "phaseBegin" },
								forced: true,
								silent: true,
								popup: false,
								async content(event, trigger, player) {
									applyWuyiBlock(player, true);
									await adjustWuyiHand(player);
								},
							},
							hand: {
								charlotte: true,
								persevereSkill: true,
								sourceSkill: "suixiang_wuyi",
								trigger: {
									global: [
										"gainAfter",
										"loseAfter",
										"loseAsyncAfter",
										"equipAfter",
										"addJudgeAfter",
										"addToExpansionAfter",
										"cardsDiscardAfter",
									],
								},
								forced: true,
								silent: true,
								popup: false,
								filter(event, player) {
									return getWuyiLevel(player) >= 4 && player.countCards("h") !== 4 && !player._suixiang_wuyi_adjusting;
								},
								async content(event, trigger, player) {
									await adjustWuyiHand(player);
								},
							},
						},
					},
					suixiang_cuifeng: {
						audio: "ext:随想录/audio/skill:4",
						persevereSkill: true,
						trigger: { global: "phaseBegin" },
						filter(event, player) {
							return (
								(player.getStorage("suixiang_cuifeng_roundcount") || 0) < 2 &&
								player.isIn() &&
								game.hasPlayer((current) => current !== player && current.isIn())
							);
						},
						async cost(event, trigger, player) {
							event.result = await player
								.chooseTarget({
									prompt: "摧锋：选择一名其他角色使用【决斗】",
									filterTarget(card, player2, target) {
										return target !== player2 && target.isIn();
									},
									ai(target) {
										const player2 = get.player();
										return get.effect(target, { name: "juedou" }, player2, player2);
									},
								})
								.forResult();
						},
						async content(event, trigger, player) {
							const target = event.targets?.[0];
							if (!target || !target.isIn()) return;
							player.storage.suixiang_cuifeng_roundcount = (player.getStorage("suixiang_cuifeng_roundcount") || 0) + 1;
							const names = getWuyiNames(player).slice();
							const unlocks = refreshCuifengUnlocks(player).slice();
							const snapshot = { names, unlocks };
							const next = player.useCard({
								card: { name: "juedou" },
								targets: [target],
								addCount: false,
							});
							next.suixiang_cuifeng_snapshot = snapshot;
							next.oncard = () => {
								if (unlocks.includes("sha")) {
									next.customArgs[target.playerid] ??= {};
									next.customArgs[target.playerid].extraDamage = names.length;
								}
								if (unlocks.includes("shan")) next.directHit.add(target);
							};
							await next;
						},
						group: ["suixiang_cuifeng_damage", "suixiang_cuifeng_round"],
						ai: {
							order: 1,
							result: {
								target(player, target) {
									return get.effect(target, { name: "juedou" }, player, player);
								},
							},
						},
						subSkill: {
							round: {
								charlotte: true,
								persevereSkill: true,
								trigger: { global: "roundStart" },
								forced: true,
								silent: true,
								popup: false,
								content(event, trigger, player) {
									delete player.storage.suixiang_cuifeng_roundcount;
								},
							},
							damage: {
								charlotte: true,
								persevereSkill: true,
								sourceSkill: "suixiang_cuifeng",
								trigger: { global: "damage" },
								forced: true,
								silent: true,
								popup: false,
								priority: Infinity,
								filter(event, player) {
									if (!event.num || event.num <= 0) return false;
									const context = getCuifengDuelContext(event, player);
									if (!context) return false;
									const { unlocks } = context.snapshot;
									if (context.targetDamage && (unlocks.includes("jiu") || unlocks.includes("tao"))) return true;
									if (unlocks.includes("unrecorded")) {
										return getBasicCardNames().some((name) => !getWuyiNames(player).includes(name));
									}
									return false;
								},
								async content(event, trigger, player) {
									const context = getCuifengDuelContext(trigger, player);
									if (!context) return;
									game.trySkillAudio?.("suixiang_cuifeng", player, true, null, {
										audio: [
											"ext:随想录/audio/skill/suixiang_cuifeng3.mp3",
											"ext:随想录/audio/skill/suixiang_cuifeng4.mp3",
										],
									});
									const { snapshot } = context;
									const { unlocks } = snapshot;
									if (unlocks.includes("unrecorded")) {
										const candidates = getBasicCardNames().filter((name) => !getWuyiNames(player).includes(name));
										if (candidates.length) {
											const name = candidates.randomGet();
											if (recordWuyiName(player, name)) await applyWuyiProgress(player);
										}
									}
									if (context.targetDamage) {
										if (unlocks.includes("jiu")) addCuifengJiu(trigger.player);
										if (unlocks.includes("tao")) addCuifengTao(trigger.player);
									}
								},
							},
							jiu: {
								charlotte: true,
								persevereSkill: true,
								mark: true,
								marktext: "酒",
								intro: {
									content(storage) {
										return `之后${storage || 0}张牌无效`;
									},
								},
								trigger: { player: ["useCard", "respond"] },
								forced: true,
								silent: true,
								popup: false,
								priority: Infinity,
								filter(event, player) {
									return player.countMark("suixiang_cuifeng_jiu") > 0 && !!event.card;
								},
								content(event, trigger, player) {
									const count = player.countMark("suixiang_cuifeng_jiu");
									player.removeMark("suixiang_cuifeng_jiu", 1, false);
									if (count <= 1) player.removeSkill("suixiang_cuifeng_jiu");
									if (trigger.name === "useCard") {
										trigger.targets.length = 0;
										trigger.all_excluded = true;
										game.log(trigger.card, "被无效了");
									} else {
										invalidateCuifengResponse(trigger);
									}
								},
								onremove: true,
							},
							tao: {
								charlotte: true,
								persevereSkill: true,
								mark: true,
								marktext: "桃",
								intro: {
									content: "不能回复体力直到其下一个回合结束阶段开始时",
								},
								trigger: { player: "recoverBefore" },
								forced: true,
								silent: true,
								popup: false,
								content(event, trigger) {
									trigger.cancel();
								},
								onremove: true,
							},
						},
					},
					suixiang_dc_yinzhi: {
						audio: "ext:随想录/audio/skill:2",
						forced: true,
						silent: true,
						popup: false,
						mark: true,
						marktext: "鸷",
						intro: {
							content(_storage, player) {
								const count = player.storage.suixiang_dc_yinzhi_count || 0;
								return `阴鸷本局已发动${count}次，当前摸牌数为${Math.min(5, count)}。`;
							},
						},
						init(player) {
							player.storage.suixiang_dc_yinzhi_count ||= 0;
							player.storage.suixiang_dc_yinzhi_roundPlayers ||= [];
						},
						onremove(player) {
							removeYinzhiOwner(player);
							delete player.storage.suixiang_dc_yinzhi_count;
							delete player.storage.suixiang_dc_yinzhi_roundPlayers;
						},
						trigger: {
							global: ["roundStart", "phaseBeforeStart", "useCardAfter", "respondAfter"],
							player: "dieAfter",
						},
						filter(event, player, triggername) {
							if (triggername === "roundStart" || triggername === "dieAfter") return true;
							if (triggername === "phaseBeforeStart") {
								return event.player && event.player !== player && player.storage.suixiang_dc_yinzhi_roundPlayers?.includes(event.player.playerid);
							}
							const target = event.player;
							return (
								player.isIn() &&
								target &&
								target !== player &&
								player.storage.suixiang_dc_yinzhi_roundPlayers?.includes(target.playerid) &&
								yinzhiUsedHandCard(event, target)
							);
						},
						async content(event, trigger, player) {
							switch (event.triggername) {
								case "roundStart": {
									const count = Math.min(5, (player.storage.suixiang_dc_yinzhi_count || 0) + 1);
									player.storage.suixiang_dc_yinzhi_count = count;
									player.syncStorage("suixiang_dc_yinzhi_count");
									player.markSkill("suixiang_dc_yinzhi");
									const targets = game.filterPlayer((current) => current !== player);
									player.storage.suixiang_dc_yinzhi_roundPlayers = targets.map((target) => target.playerid);
									player.syncStorage("suixiang_dc_yinzhi_roundPlayers");
									for (const target of targets) {
										target.addTempSkill(yinzhiBlockSkill, { player: ["phaseBeforeStart", "dieAfter"] });
										const block = (target.storage[yinzhiBlockSkill] ||= { owners: [] });
										if (!block.owners.includes(player.playerid)) block.owners.push(player.playerid);
									}
									player.logSkill("suixiang_dc_yinzhi");
									await player.draw(count);
									break;
								}
								case "phaseBeforeStart": {
									const target = trigger.player;
									target.addTempSkill(yinzhiTurnSkill, { player: ["phaseAfter", "dieAfter"] });
									const turn = (target.storage[yinzhiTurnSkill] ||= { owners: [], cards: [] });
									if (!turn.owners.includes(player.playerid)) turn.owners.push(player.playerid);
									break;
								}
								case "useCardAfter":
								case "respondAfter":
									await player.draw(Math.min(5, player.storage.suixiang_dc_yinzhi_count || 0));
									break;
								case "dieAfter":
									removeYinzhiOwner(player);
									player.storage.suixiang_dc_yinzhi_roundPlayers = [];
									player.syncStorage("suixiang_dc_yinzhi_roundPlayers");
									break;
							}
						},
						subSkill: {
							block: {
								charlotte: true,
								persevereSkill: true,
								mark: true,
								marktext: "鸷",
								intro: { content: "所有技能失效直到你的回合开始" },
								init(player, skill) {
									player.storage[skill] ||= { owners: [] };
									player.addSkillBlocker(skill);
								},
								onremove(player, skill) {
									player.removeSkillBlocker(skill);
									delete player.storage[skill];
								},
								skillBlocker(skill) {
									if (skill === yinzhiBlockSkill || skill === yinzhiTurnSkill) return false;
									return !!lib.skill[skill];
								},
							},
							turn: {
								charlotte: true,
								persevereSkill: true,
								mark: true,
								marktext: "鸷",
								intro: { content: "本回合只能使用或打出本回合获得的牌" },
								init(player, skill) {
									player.storage[skill] ||= { owners: [], cards: [] };
								},
								onremove(player, skill) {
									const storage = player.storage[skill];
									if (storage?.cards?.length) player.removeGaintag(getYinzhiTurnTag(player), storage.cards);
									delete player.storage[skill];
								},
								mod: {
									cardEnabled(card, player) {
										if (_status.currentPhase !== player) return;
										const cards = getYinzhiCardMaterials(card);
										if (cards.length && cards.some((item) => !item.hasGaintag(getYinzhiTurnTag(player)))) return false;
									},
									cardRespondable(card, player) {
										if (_status.currentPhase !== player) return;
										const cards = getYinzhiCardMaterials(card);
										if (cards.length && cards.some((item) => !item.hasGaintag(getYinzhiTurnTag(player)))) return false;
									},
									cardSavable(card, player) {
										if (_status.currentPhase !== player) return;
										const cards = getYinzhiCardMaterials(card);
										if (cards.length && cards.some((item) => !item.hasGaintag(getYinzhiTurnTag(player)))) return false;
									},
								},
								trigger: {
									global: ["gainBegin", "equipAfter", "addJudgeAfter", "addToExpansionAfter"],
									source: "damageSource",
								},
								filter(event, player, triggername) {
									const storage = player.storage[yinzhiTurnSkill];
									if (!storage) return false;
									if (triggername === "damageSource") {
										return event.source === player && storage.owners?.includes(event.player?.playerid);
									}
									if (_status.currentPhase !== player || event.player !== player) return false;
									if (triggername === "gainBegin") return !!event.cards?.some((card) => get.owner(card, "judge") !== player);
									if (event.relatedLose?.player === player) return false;
									const cards = event.cards || event.card?.cards || [];
									const owned = player.getCards("hejsxj");
									return cards.some((card) => owned.includes(card));
								},
								async content(event, trigger, player) {
									const storage = player.storage[yinzhiTurnSkill];
									const tag = getYinzhiTurnTag(player);
									switch (event.triggername) {
										case "gainBegin": {
										const cards = (trigger.cards || []).filter((card) => get.owner(card, "judge") !== player);
										if (cards.length) game.broadcastAll((cards2, tag2) => cards2.forEach((card) => card.addGaintag(tag2)), cards, tag);
										for (const card of cards) {
												if (!storage.cards.includes(card)) storage.cards.push(card);
											}
											break;
										}
										case "equipAfter":
										case "addJudgeAfter":
										case "addToExpansionAfter": {
											const owned = player.getCards("hejsxj");
											const cards = (trigger.cards || trigger.card?.cards || []).filter((card) => owned.includes(card));
											if (cards.length) {
												game.broadcastAll((cards2, tag2) => cards2.forEach((card) => card.addGaintag(tag2)), cards, tag);
												for (const card of cards) {
													if (!storage.cards.includes(card)) storage.cards.push(card);
												}
											}
											break;
										}
										case "damageSource": {
											const owner = game.playerMap[trigger.player.playerid] || lib.playerOL[trigger.player.playerid];
											if (!owner?.isIn()) break;
											const owned = player.getCards("hejsxj");
											const cards = storage.cards.filter((card) => owned.includes(card));
											if (cards.length) await owner.gain(cards, "gain2");
											break;
										}
									}
								},
							},
						},
					},
					suixiang_dc_keming: {
						audio: "ext:随想录/audio/skill:2",
						init(player) {
							player.storage.suixiang_dc_keming_usedPlayers ||= [];
						},
						onremove(player) {
							delete player.storage.suixiang_dc_keming_usedPlayers;
						},
						trigger: {
							player: "damageEnd",
							source: "damageSource",
						},
						filter(event, player, triggername) {
							const target = lib.suixiang_dc_keming_api.getDamageTarget(event, triggername);
							return !!target && target !== player && event.num > 0;
						},
						logTarget(event, _player, triggername) {
							return lib.suixiang_dc_keming_api.getDamageTarget(event, triggername);
						},
						async cost(event, trigger, player) {
							const api = lib.suixiang_dc_keming_api;
							const target = api.getDamageTarget(trigger, event.triggername);
							if (!target || target === player) {
								event.result = { bool: false };
								return;
							}
							const targetSkills = api.getStealableSkills(target);
							const ownerSkills = new Set(player.getSkills("invisible", false, false));
							const hasSameSkill = targetSkills.some((skill) => ownerSkills.has(skill));
							const sameSurnamePool = hasSameSkill ? api.getCharacterPool(target, ownerSkills, "surname") : [];
							const caoSurnamePool = hasSameSkill ? api.getCharacterPool(target, ownerSkills, "cao") : [];
							if (!targetSkills.length || (hasSameSkill && !sameSurnamePool.length && !caoSurnamePool.length)) {
								event.result = { bool: false };
								return;
							}
							const result = await player
								.chooseBool({
									prompt: "是否发动【刻名】？",
									prompt2: hasSameSkill
										? `你已拥有${get.translation(target)}的技能，请选择从同姓武将或曹姓武将中获得一项技能。`
										: `获得${get.translation(target)}的一项技能。`,
									choice: true,
								})
								.set("ai", () => true)
								.forResult();
							if (!result?.bool) {
								event.result = { bool: false };
								return;
							}
							let options;
							if (hasSameSkill) {
								let pool = "surname";
								const controls = [];
								const sameAndCaoPoolEquivalent =
									sameSurnamePool.length === caoSurnamePool.length &&
									sameSurnamePool.every((name) => caoSurnamePool.includes(name));
								if (sameSurnamePool.length) controls.push("同姓武将技能");
								if (caoSurnamePool.length && !sameAndCaoPoolEquivalent) controls.push("曹姓武将技能");
								if (controls.length > 1) {
									const source = await player
										.chooseControl({
											controls,
											prompt: "刻名：选择获得技能的武将范围",
											choice: 0,
										})
										.set("ai", () => controls[0])
										.forResult();
									pool = source?.control === "曹姓武将技能" ? "cao" : "surname";
								} else if (controls[0] === "曹姓武将技能") {
									pool = "cao";
								}
								options = api.getSurnameSkillOptions(target, ownerSkills, pool);
							} else {
								options = api.getTargetSkillOptions(target, targetSkills);
							}
							if (!options.length) {
								event.result = { bool: false };
								return;
							}
							const choice = await player
								.chooseButton(api.getSkillChoiceDialog("刻名：选择获得一项技能", options))
								.set("forced", true)
								.set("ai", (button) => get.skillRank(button.link, "inout"))
								.forResult();
							event.result = {
								bool: !!choice?.bool && !!choice.links?.length,
								cost_data: choice?.links?.[0],
							};
						},
						async content(event, _trigger, player) {
							const skill = event.cost_data;
							if (!skill || !lib.skill[skill]) return;
							await player.addAdditionalSkills("suixiang_dc_keming", [skill], true);
						},
						// “每回合每名角色限一次”只限制 watch 替换分支，不限制伤害后的技能获得。
						group: ["suixiang_dc_keming_watch", "suixiang_dc_keming_reset"],
						subSkill: {
							watch: {
								charlotte: true,
								audio: "suixiang_dc_keming",
								trigger: { global: ["useSkillAfter", "logSkill"] },
								filter(event, player) {
									if (event.type !== "player" || !event.player || event.player === player) return false;
									const skill = get.sourceSkillFor(event);
									return (
										!!skill &&
										player.getSkills("invisible", false, false).includes(skill) &&
											event.player.getSkills("invisible", false, false).includes(skill) &&
										!player.storage.suixiang_dc_keming_usedPlayers?.includes(event.player.playerid)
									);
								},
								async cost(event, trigger, player) {
									const api = lib.suixiang_dc_keming_api;
									const target = trigger.player;
									const skill = get.sourceSkillFor(trigger);
									if (!target || target === player || !skill) {
										event.result = { bool: false };
										return;
									}
									const excluded = new Set([...target.getSkills("invisible", false, false), skill]);
									const options = api.getSurnameSkillOptions(target, excluded);
									if (!options.length) {
										event.result = { bool: false };
										return;
									}
									const result = await player
										.chooseBool({
											prompt: "是否发动【刻名】？",
											prompt2: `将${get.translation(skill)}替换为随机三名同姓武将中的一项技能。`,
											choice: true,
										})
										.set("ai", () => get.attitude(player, target) < 0)
										.forResult();
									if (!result?.bool) {
										event.result = { bool: false };
										return;
									}
									const choice = await player
										.chooseButton(api.getSkillChoiceDialog(`刻名：选择替换${get.translation(skill)}的技能`, options))
										.set("forced", true)
										.set("ai", (button) => get.skillRank(button.link, "inout"))
										.forResult();
									event.result = {
										bool: !!choice?.bool && !!choice.links?.length,
										cost_data: choice?.links?.[0],
									};
								},
								async content(event, trigger, player) {
									const target = trigger.player;
									const skill = get.sourceSkillFor(trigger);
									const replacement = event.cost_data;
									if (!target || !skill || !replacement || replacement === skill || !lib.skill[replacement]) return;
									const usedPlayers = (player.storage.suixiang_dc_keming_usedPlayers ||= []);
									if (
										usedPlayers.includes(target.playerid) ||
										!target.getSkills("invisible", false, false).includes(skill) ||
										target.getSkills("invisible", false, false).includes(replacement)
									) {
										return;
									}
									usedPlayers.push(target.playerid);
									player.syncStorage("suixiang_dc_keming_usedPlayers");
									await target.changeSkills([replacement], [skill]);
								},
							},
							reset: {
								charlotte: true,
								forced: true,
								silent: true,
								popup: false,
								priority: 1000,
								trigger: { global: "phaseBefore" },
								content(event, trigger, player) {
									player.storage.suixiang_dc_keming_usedPlayers = [];
									player.syncStorage("suixiang_dc_keming_usedPlayers");
								},
							},
						},
					},
					suixiang_wuyi_block: {
						charlotte: true,
						persevereSkill: true,
						mark: true,
						marktext: "翊",
						intro: {
							content: "本回合你的非持恒技能失效",
						},
						init(player, skill) {
							player.addSkillBlocker(skill);
						},
						onremove(player, skill) {
							player.removeSkillBlocker(skill);
						},
						skillBlocker(skill) {
							if (skill === "suixiang_wuyi_block") return false;
							const info = lib.skill[skill];
							return !!info && !info.persevereSkill;
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
					suixiang_dc_yinzhi: "阴鸷",
					suixiang_dc_yinzhi_info:
						"每轮开始时，所有其他角色技能失效直到其回合开始时，你摸X张牌，这些角色每次使用或打出手牌后你摸X张牌（X为阴鸷本局游戏发动的次数，至多为5）。然后其回合内只能使用或打出本回合获得的牌，若其对你造成伤害，你获得其本回合获得的牌。",
					suixiang_dc_yinzhi_block: "阴鸷·封技",
					suixiang_dc_yinzhi_turn: "阴鸷·限牌",
					"#ext:随想录/audio/skill/suixiang_dc_yinzhi1": "大袖蔽天穹，日月一息起，逆我者，永堕无明！",
					"#ext:随想录/audio/skill/suixiang_dc_yinzhi2": "枯骨九重阶，血墨万卷诏，孤不怿以天为父！",
					suixiang_dc_keming: "刻名",
					suixiang_dc_keming_info:
						"当你受到其他角色造成的伤害或对其他角色造成伤害后，你可以获得该角色身上一个技能，若你已拥有与目标同名技能，改为从三个与其同姓武将中选一个技能获得。每回合每名角色限一次，若其他角色发动了你拥有的技能，则你可以从随机三名其同姓武将中选一个技能替换其对应技能。",
					suixiang_dc_keming_watch: "刻名",
					suixiang_dc_keming_reset: "刻名",
					"#ext:随想录/audio/skill/suixiang_dc_keming1": "冠我名于九州，始知天下多好臣！",
					"#ext:随想录/audio/skill/suixiang_dc_keming2": "我言成诏，汝名成囚！",
					suixiang_mou_huoji: "火计",
					suixiang_mou_huoji_info:
						"使命技，出牌阶段限一次，你可以选择一名其他角色，对其与其势力相同的其他角色各造成1点火焰伤害。若其中有角色因此进入濒死，你可以再次发动本技能；每回合第X次额外发动造成的伤害增加X点（X为本回合本技能额外发动的次数），限本次出牌阶段内链式追加。成功：准备阶段，若有角色曾因火焰伤害进入过濒死，你失去〖火计〗，获得〖观星〗和〖空城〗。失败：成功前你进入濒死时，你将体力回复至上限，然后使命失败。",
					"#ext:随想录/audio/skill/suixiang_mou_huoji1": "区区汉贼，怎挡天火之威？",
					"#ext:随想录/audio/skill/suixiang_mou_huoji2": "就让此火，再兴炎汉国祚。",
					"#ext:随想录/audio/skill/suixiang_mou_huoji3": "吾虽有功，然终逆天命啊。",
					suixiang_mou_guanxing: "观星",
					suixiang_mou_guanxing_info:
						"锁定技，你的手牌数始终为0，牌堆顶七张牌对你始终可见。每当你从手牌区弃置牌后，你将这些牌置于武将牌上，称为“星”。你可以如同使用或打出手牌般使用或打出“星”和牌堆顶的七张牌；你以此法使用牌堆顶的牌无距离和次数限制。每名角色的准备阶段，你可以调整牌堆顶七张牌的顺序，并将其中任意张置于牌堆底。",
					suixiang_mou_kongcheng: "空城",
					suixiang_mou_kongcheng_info:
						"锁定技，你没有手牌时，不能成为【杀】或【决斗】的目标。当你即将受到伤害时，你可以弃置三张“星”，令此伤害无效。",
					suixiang_mou_kanpo: "看破",
					suixiang_mou_kanpo_info:
						"游戏开始时，你可以选择0至4个当前牌堆中的牌名并记录（可重复）。其他角色使用与你记录牌名相同的牌时，你可以移去一个对应记录，令此牌无效并摸一张牌，然后你可以记录一个与刚移去牌名不同的牌名（可与已有记录重复）。若〖火计〗使命失败，则令此牌使用者的所有非锁定技失效至下一轮开始，并对其造成1点无来源伤害。",
					"#ext:随想录/audio/skill/suixiang_mou_kanpo1": "知汝欲行此计，故已待之久矣。",
					"#ext:随想录/audio/skill/suixiang_mou_kanpo2": "静思敌谋，以出应对之策。",
					"#ext:随想录/audio/skill/suixiang_mou_guanxing1": "明星皓月，前路通达。",
					"#ext:随想录/audio/skill/suixiang_mou_guanxing2": "冷夜孤星，正如时局啊。",
					"#ext:随想录/audio/skill/suixiang_mou_kongcheng1": "城下千军万马，我亦谈笑自若。",
					"#ext:随想录/audio/skill/suixiang_mou_kongcheng2": "仲达可愿与我城中一叙？",
					suixiang_wuyi: "武翊",
					suixiang_wuyi_info:
						"持恒技。你本局累计使用或打出过的基本牌牌名数达到1种时，你使用牌无距离和次数限制；达到2种时，你视为拥有〖龙魂〗；达到3种时，你的回合内其他角色的非持恒技失效；达到4种时，你的手牌数始终为4。",
					// 势赵云语音：武翊按记录牌名阶段使用第1-4句，龙魂使用第5-6句，摧锋使用完整4句。
					"#ext:随想录/audio/skill/suixiang_wuyi1": "年少自仗心胆，扬名岂须待时？",
					"#ext:随想录/audio/skill/suixiang_wuyi2": "百战征袍不染，枪破万军无还！",
					"#ext:随想录/audio/skill/suixiang_wuyi3": "海角终有尽，天涯必可及！",
					"#ext:随想录/audio/skill/suixiang_wuyi4": "勇略已超天下将，再炽心气问天高！",
					suixiang_longhun: "龙魂",
					suixiang_longhun_info:
						"你可以将一至两张牌按下列规则使用或打出：红桃当【桃】，方块当火【杀】，梅花当【闪】，黑桃当【无懈可击】。若你以此法使用的牌为两张：使用的【桃】令目标角色加1点体力上限，使用的火【杀】额外结算两次，使用的【闪】令此【杀】的使用者随机弃置两张牌，使用的【无懈可击】不能被响应且你获得被响应的牌。",
					"#ext:随想录/audio/skill/suixiang_longhun1": "见吾银枪白马，当知胜负已分。",
					"#ext:随想录/audio/skill/suixiang_longhun2": "此战胜已在胸，自立不败之地。",
					suixiang_cuifeng: "摧锋",
					suixiang_cuifeng_info:
						"持恒技。每轮限两次。每个回合开始时，你可以对一名其他角色使用【决斗】。你拥有〖武翊〗时解锁“未记录”效果；〖武翊〗记录【杀】、【闪】、【酒】、【桃】后分别解锁对应效果。已解锁的效果永久生效：未记录，造成伤害后随机记录一个未记录的基本牌名；【杀】，此【决斗】造成的伤害+X（X为〖武翊〗记录的牌名数）；【闪】，此【决斗】不可响应；【酒】，其受到此【决斗】伤害后，其下一张使用或打出的牌无效；【桃】，其受到此【决斗】伤害后，直到其下一个回合结束阶段开始时不能回复体力。",
					"#ext:随想录/audio/skill/suixiang_cuifeng1": "纵对千军万马，云亦独往矣！",
					"#ext:随想录/audio/skill/suixiang_cuifeng2": "冲阵斩将者，常山赵子龙也！",
					"#ext:随想录/audio/skill/suixiang_cuifeng3": "凡吾枪所向，必一往无前！",
					"#ext:随想录/audio/skill/suixiang_cuifeng4": "七破绝境，此枪砥砺更利！",
					suixiang_cuifeng_jiu: "摧锋·酒",
					suixiang_cuifeng_tao: "摧锋·桃",
					suixiang_wuyi_block: "武翊",
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
						"锁定技。每轮开始时，所有角色同时为你选择两项“权御”效果（两项不可相同；辟邪、紫电与流星本局每人限选一次），然后你摸X张牌（X为其中与你本轮选择相同的角色数，不设上限）。你使用伤害牌指定目标后，执行全部“权御”效果：白虹：基础伤害+1；青冥：每层可额外选择一个目标（自由选择数量，可随时停止）；辟邪：无视防具；紫电：不可响应；百里：额外结算一次；流星：无次数限制。所有角色的选择永久累计并强化你。",
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
						"锁定技。你使用牌指定一名角色为目标后：若你与其本轮的“权御”选择存在相同效果，你从牌堆获得一张不计入手牌上限的【杀】；若存在不同效果，你随机弃置其一张牌，然后对其发动一次“权御”。（仅一项相同时，两项效果均触发。）",
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
					"#ext:随想录/audio/die/suixiang-shi_zhaoyun:die": "吾平生未有败事，岂料今日，…呃…",
					"#ext:随想录/audio/die/suixiang-mb_shen_machao:die": "我裁万世，何以裁我……",
					"#ext:随想录/audio/die/suixiang-dm_sunquan:die": "朕非朕，天下皆朕！",
				},
			},
			intro: "随想录扩展：所有武将/技能均以 suixiang 为前缀。下载地址：https://github.com/keepermttl/noname-suixianglu",
			author: "伽拉忒亚",
			version: "1.3.16",
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
