"use strict";

/*
 * Xw Card Writing Assistant（卡片式写作案板）V1.0.02
 * ------------------------------------------------------------------
 * 按卡片式写作案板的通用标准：
 *   1. 案板分行，行尾可以设「铰链」（默认不预设，可在铰链里自行填写）
 *   2. 每张卡 = 一个场景：内外景＋地点＋日夜、一句话动作、＋/－ 情绪转变、＞＜ 冲突
 *   3. 色彩编码：按人物/线索给卡片上色，看穿线
 *
 * V1.0.01（首个公开上架版）：
 *   - 卡片式写作案板：一张卡 = 一个场景；拖拽互换/插入（插入位置用线表示）、
 *     批量多选整组移动、幕/列数可调、幕可折叠、幕头备注可拖动排序
 *   - 格式刷刷尺寸、宽/高锁定、新建卡跟随最近调整的尺寸、卡片统一编号
 *   - 15 张空白节拍卡 + 自定义节拍模板；「导语」「衔接点」特型节拍卡
 *   - 状态灯提示缺项、汇总导出与一键自检；全部写回 Markdown 纯文本
 *
 * 卡片存放在 Markdown 文件里，一对注释标记之间，格式：
 *   <!-- stc:board:start -->
 *   <!-- stc:acts: 第一幕 | 第二幕 | 第三幕 | 第四幕 -->
 *   <!-- stc:cols: 1 | 1 | 1 | 1 -->
 *   <!-- stc:hinge: （各行铰链可自行填写） -->
 *   ### 卡01 · 节拍01
 *   - 幕：第一幕
 *   - 节拍：节拍01
 *   - 场：内景 林川的公寓 日
 *   - 事：林川勇敢地面对苏晴的秘密。
 *   - ＋/－：＋ → －｜情绪变化：……
 *   - ＞＜：林川 vs 苏晴｜冲突点：……｜结果：……
 *   - 色：林川
 *   - 宽：300
 *   - 高：176
 *   <!-- stc:board:end -->
 *
 * 老格式（没有 stc:acts 那三行）照样能读，按默认四幕处理。
 */

const {
	Plugin,
	ItemView,
	Notice,
	Modal,
	Setting,
	PluginSettingTab,
	TFile,
	FuzzySuggestModal,
	normalizePath,
} = require("obsidian");

const VIEW_TYPE = "xw-card-board-view";
const START_MARK = "<!-- stc:board:start -->";
const END_MARK = "<!-- stc:board:end -->";

/* ---------------------------------------------------------------- 常量 */

/* 默认四幕（起改为 第一幕～第四幕）。
   案板可以在文件里用 <!-- stc:acts: --> 覆盖成任意几幕；
   老案板里已写好的 <!-- stc:acts: 第一幕 | 第二幕上 | ... --> 照样原样生效。 */
const ACTS = [
	{ key: "第一幕", pages: "", ratio: 25 },
	{ key: "第二幕", pages: "", ratio: 30 },
	{ key: "第三幕", pages: "", ratio: 30 },
	{ key: "第四幕", pages: "", ratio: 25 },
];

const ACT_KEYS = ACTS.map((a) => a.key);

/* 行末铰链：转折点必然是每一行的最后一张卡（发布版默认不预设铰链，可自行设置） */
const HINGE = {};

/*  发布版（用户要求）：不预置任何固定节拍（BEATS 为空）——
   节拍下拉默认只有「（不填）」和自定义节拍模板；「插入 15 张空白节拍卡」插出的卡节拍为空 */
const BEATS = [];

/* 每个节拍是干什么用的。
   卡片上没写「事」的时候、以及弹窗里选中某个节拍时，都会把它显示出来。
   发布版：固定节拍不带释义（空白节拍）；保留「衔接点」「导语」两个通用概念的释义，
   供用户自建同名节拍模板时使用。 */
const BEAT_DESC = {
	衔接点: "通用转场卡：标记故事从一个段落进入下一个段落。带「转折点」标记；标准四个转折位之外的自定义衔接用它。",
	导语: "开篇引子：几句话把读者勾进来，垫定全篇的语气。无论卡放在哪，编号固定 00，汇总导出时排在全文最前面。",
};

/* 拿一个节拍的释义（认别名）。自定义节拍的释义在 CUSTOM_BEAT_DESC 里。 */
function beatDesc(beat) {
	const b = normBeat(beat);
	return (b && BEAT_DESC[b]) || (b && CUSTOM_BEAT_DESC[b]) || "";
}

/* ---------- 自定义节拍模板 ----------
   用户在设置面板里加的节拍，比如「角色卡」这类模块卡。
   存在 settings.customBeats：[{ name, act, desc }]，
   act 是默认幕名（"" = 落「待定」收卡盘），desc 可选。
   这里用两个模块级映射让纯函数（Card.act / beatDesc）也能查到；
   syncCustomBeats() 在载入设置和设置面板改动时刷新。 */
let CUSTOM_BEAT_ACT = {};
let CUSTOM_BEAT_DESC = {};

function cleanCustomBeats(list) {
	const out = [];
	if (!Array.isArray(list)) return out;
	for (const it of list) {
		if (!it) continue;
		const name = String(it.name || "").trim();
		if (!name) continue;
		out.push({ name: name, act: String(it.act || "").trim(), desc: String(it.desc || "").trim() });
	}
	return out;
}

function syncCustomBeats(list) {
	CUSTOM_BEAT_ACT = {};
	CUSTOM_BEAT_DESC = {};
	for (const it of cleanCustomBeats(list)) {
		const key = normBeat(it.name);
		if (!key) continue;
		if (it.act) CUSTOM_BEAT_ACT[key] = it.act;
		if (it.desc) CUSTOM_BEAT_DESC[key] = it.desc;
	}
}

/* 自定义节拍的名字列表（保持用户排序） */
function customBeatNames(settings) {
	return cleanCustomBeats(settings && settings.customBeats).map((it) => it.name);
}

/* 节拍 → 默认幕名：固定表优先，再查自定义模板 */
function beatActOf(beat) {
	const b = normBeat(beat);
	if (!b) return "";
	return BEAT_ACT[b] || CUSTOM_BEAT_ACT[b] || "";
}

/* 节拍 → 该节拍所属的行（转折点归它"结束"的那一行） */
const BEAT_ACT = {};

const BEAT_ALIAS = {};

/* 卡片字段名（中英文都认） */
const K = {
	act: "幕",
	beat: "节拍",
	scene: "场",
	action: "事",
	pm: "＋/－",
	conflict: "＞＜",
	color: "色",
	/* （用户要求）：「源」字段整体移除 */
	note: "备",
	width: "宽",
	height: "高",
	col: "列",
};

const KEY_ALIAS = {
	幕: K.act,
	act: K.act,
	行: K.act,
	节拍: K.beat,
	beat: K.beat,
	场: K.scene,
	scene: K.scene,
	场景: K.scene,
	事: K.action,
	action: K.action,
	动作: K.action,
	"＋/－": K.pm,
	"+/-": K.pm,
	"＋－": K.pm,
	情绪: K.pm,
	正负: K.pm,
	"＞＜": K.conflict,
	"><": K.conflict,
	"> <": K.conflict,
	冲突: K.conflict,
	色: K.color,
	color: K.color,
	色彩: K.color,
	色彩编码: K.color,
	备: K.note,
	备注: K.note,
	note: K.note,
	列: K.col,
	col: K.col,
	宽: K.width,
	宽度: K.width,
	w: K.width,
	width: K.width,
	高: K.height,
	高度: K.height,
	h: K.height,
	height: K.height,
};

/* 没在色彩编码表里指定颜色时，按名字哈希从这里挑一个稳定颜色 */
const PALETTE = [
	"#c0392b",
	"#d97706",
	"#a67c00",
	"#2e7d32",
	"#00796b",
	"#2c5f9e",
	"#7b3fa0",
	"#6b7280",
];

const DEFAULT_W = 300;
const DEFAULT_H = 176;
const MIN_W = 170;
/* 最低高度 = 标题一行 + 正文一行（用户要求：拉到最小就只剩两行的高度） */
const MIN_H = 56;
/* 卡片中腹多大范围算「互换」而不是「插到前后」（0.26 = 上下左右各留 26% 做插入区） */
const SWAP_ZONE = 0.26;
/* 格式刷按钮的图标：单色矢量刷子（用 currentColor，跟随主题文字色） */
const BRUSH_SVG =
	'<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
	'<path d="M19.9 4.1a1.9 1.9 0 0 0-2.7 0l-7.2 7.2 2.7 2.7 7.2-7.2a1.9 1.9 0 0 0 0-2.7z" fill="currentColor"/>' +
	'<path d="M9.4 12.4 6.6 15.2c-1 1-1 2.6-.1 3.6-.7 1-1.9 1.7-3.4 1.9 1.3-.9 1.7-2 1.4-3.1-.4-1.5.2-2.9 1.3-3.9l2.7-2.4.9 1.1z" fill="currentColor" opacity="0.7"/>' +
	"</svg>";
/* 批量选择/移动按钮图标：虚线框 = 框选多张卡 */
const BATCH_SVG =
	'<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
	'<rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3.4 2.4"/>' +
	'<path d="M8.5 12.2l2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
	"</svg>";
const MAX_COLS = 6;

const DEFAULT_SETTINGS = {
	boardFile: "",
	boardFolder: "",
	colorMap: "",
	/* （用户要求）：卡数检查功能已移除。这两个键只为兼容旧 data.json 保留，
	   代码里不再读取，也不会再写回。 */
	rowTarget: 0,
	totalTarget: 0,
	markBad: false,
	customBeats: [],
};

/* ---------------------------------------------------------------- 工具 */

function pad2(n) {
	return (n < 10 ? "0" : "") + n;
}

function hashStr(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

/* 名字 → 稳定颜色（和色彩编码表里的颜色一致） */
function autoColor(name) {
	const n = String(name == null ? "" : name).trim();
	if (!n) return "";
	if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(n)) return n;
	return PALETTE[hashStr(n) % PALETTE.length];
}

function squash(s) {
	return String(s == null ? "" : s)
		.replace(/[\s（）()【】\[\]]/g, "")
		.replace(/[-–—~～]/g, "")
		.trim();
}

function toInt(v, dflt) {
	const n = parseInt(v, 10);
	return isNaN(n) ? dflt : n;
}

function guessDefaultAct(t) {
	if (!t) return "";
	if (t === "第一幕" || t === "幕1" || t === "1" || t === "一") return "第一幕";
	/*  默认幕名改为 第一幕～第四幕；老写法「第二幕上/下」也认（映射到新名） */
	if (/第四|四/.test(t) && t.indexOf("第") > -1 && t.indexOf("第四") > -1) return "第四幕";
	if (t.indexOf("第二幕") > -1) {
		if (/前半|上|a|A/.test(t)) return "第二幕";
		if (/后半|下|b|B/.test(t)) return "第三幕";
		return "第二幕";
	}
	if (t.indexOf("第四幕") > -1) return "第四幕";
	if (t.indexOf("第四") > -1) return "第四幕";
	if (t.indexOf("第三幕") > -1) return "第三幕";
	if (t.indexOf("第三") > -1) return "第三幕";
	if (t.indexOf("第二") > -1) return "第二幕";
	if (t.indexOf("第一") > -1) return "第一幕";
	return "";
}

/* 幕名归一：可以传入当前案板自己的幕清单（keys） */
function normAct(raw, keys) {
	const list = keys && keys.length ? keys : ACT_KEYS;
	if (!raw) return "";
	const t = squash(raw);
	if (!t) return "";
	for (const k of list) {
		if (t === squash(k)) return k;
	}
	const guess = guessDefaultAct(t);
	if (guess && list.indexOf(guess) > -1) return guess;
	for (const k of list) {
		const kk = squash(k);
		if (kk && (t.indexOf(kk) > -1 || kk.indexOf(t) > -1)) return k;
	}
	if (t === "待定" || t === "未定" || t === "戏" || t === "收卡盘") return "待定";
	return "";
}

function normBeat(raw) {
	if (!raw) return "";
	const t = String(raw).replace(/^\s*【|】\s*$/g, "").trim();
	if (!t) return "";
	if (BEATS.indexOf(t) > -1) return t;
	const stripped = t.replace(/[（(].*?[)）]/g, "").trim();
	for (const b of BEATS) {
		if (b === stripped) return b;
		const bs = b.replace(/[（(].*?[)）]/g, "");
		if (bs === stripped) return b;
	}
	const lower = t.toLowerCase();
	if (BEAT_ALIAS[lower]) return BEAT_ALIAS[lower];
	for (const key of Object.keys(BEAT_ALIAS)) {
		if (lower.indexOf(key.toLowerCase()) > -1) return BEAT_ALIAS[key];
	}
	/* （用户报）：走到这里＝自定义节拍名（固定节拍都没匹配上）。
	   以前返回剥过【】的 t，「短篇-转折上【缓】」结尾的】就在卡面上消失了。
	   现在原样返回，自定义名里的【】一个都不动。 */
	return String(raw).trim() || t;
}

function isTerminator(beat) {
	const b = normBeat(beat);
	return (
		b === "衔接点" /* ：通用衔接点也带「转折点」标记（用户指定新增的固定节拍） */
	);
}

function countArrows(s) {
	const m = String(s == null ? "" : s).match(/→|->|=>|～>|⇒|-->|—>/g);
	return m ? m.length : 0;
}

/* ＋/－ 的规范写法是「开头基调 → 结尾基调｜说明」。
   转变只写在「｜」之前；后面的说明里出现 → 不算第二次转变。 */
function pmLead(s) {
	const str = String(s == null ? "" : s);
	const i = str.search(/[｜|]/);
	return i >= 0 ? str.slice(0, i) : str;
}

/* ＋/－ 拆成「开头基调 / 结尾基调 / 说明」。拆不动就把全文当说明。 */
const PM_RE = /^\s*([＋+\-－])\s*(?:→|->|=>|—>)\s*([＋+\-－]?)\s*(?:[｜|]\s*([\s\S]*))?\s*$/;

function pmParts(s) {
	const str = String(s == null ? "" : s).trim();
	if (!str) return { from: "", to: "", note: "", ok: false };
	const m = PM_RE.exec(str);
	if (!m) return { from: "", to: "", note: str, ok: false };
	return { from: m[1] || "", to: m[2] || "", note: (m[3] || "").trim(), ok: true };
}

function pmText(from, to, note) {
	const f = String(from || "").trim();
	const t = String(to || "").trim();
	const n = String(note || "").trim();
	if (!f && !t) return n;
	let s = f + " → " + t;
	if (n) s += "｜" + n;
	return s;
}

/* ＞＜ 拆成「谁 vs 谁 / 冲突点 / 结果」。
   旧写法（`赢家：X`、以及没有标签的那一段）照读，并且**原样写回**，不丢字。 */
function cfParts(s) {
	const str = String(s == null ? "" : s).trim();
	const out = { a: "", b: "", point: "", result: "", pointLabel: "冲突点", resultLabel: "结果" };
	if (!str) return out;
	const segs = str.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
	if (segs.length) {
		const m = /\s+vs\.?\s+/i.exec(segs[0]);
		if (m) {
			out.a = segs[0].slice(0, m.index).trim();
			out.b = segs[0].slice(m.index + m[0].length).trim();
		} else {
			out.a = segs[0];
		}
	}
	for (let i = 1; i < segs.length; i++) {
		let m = /^(冲突点|赢家)\s*[：:]\s*([\s\S]*)$/.exec(segs[i]);
		if (m && !out.point) {
			out.point = m[2].trim();
			out.pointLabel = m[1];
			continue;
		}
		m = /^结果\s*[：:]\s*([\s\S]*)$/.exec(segs[i]);
		if (m && !out.result) {
			out.result = m[1].trim();
			continue;
		}
		if (!out.result) {
			out.result = segs[i];
			out.resultLabel = "";
		} else {
			out.result += "｜" + segs[i];
		}
	}
	return out;
}

function cfText(a, b, point, result, pointLabel, resultLabel) {
	const A = String(a || "").trim();
	const B = String(b || "").trim();
	const P = String(point || "").trim();
	const R = String(result || "").trim();
	const lp = pointLabel === "赢家" ? "赢家" : "冲突点";
	const lr = resultLabel === "" ? "" : "结果";
	let s = A && B ? A + " vs " + B : A || B;
	if (P) s += (s ? "｜" : "") + lp + "：" + P;
	if (R) s += (s ? "｜" : "") + (lr ? lr + "：" : "") + R;
	return s;
}

function sepCount(s, chars) {
	const str = String(s == null ? "" : s);
	let n = 0;
	for (let i = 0; i < str.length; i++) {
		if (chars.indexOf(str[i]) >= 0) n++;
	}
	return n;
}

function clampCols(n) {
	const v = toInt(n, 1);
	if (v < 1) return 1;
	if (v > MAX_COLS) return MAX_COLS;
	return v;
}

/* ---------------------------------------------------------------- 卡片模型 */

class Card {
	constructor() {
		this.fields = []; // [{k, v}] 保序，未知字段也能原样写回
		this.notes = []; // 块内非字段行
	}

	get(key) {
		for (const f of this.fields) {
			if (f.k === key) return f.v;
		}
		return "";
	}

	set(key, val) {
		val = String(val == null ? "" : val);
		for (const f of this.fields) {
			if (f.k === key) {
				f.v = val;
				return;
			}
		}
		this.fields.push({ k: key, v: val });
	}

	del(key) {
		this.fields = this.fields.filter((f) => f.k !== key);
	}

	/* 幕：优先取显式字段，其次由节拍推导（自定义节拍模板也认） */
	act(keys) {
		const a = normAct(this.get(K.act), keys);
		if (a) return a;
		const guess = beatActOf(this.get(K.beat));
		if (guess && (!keys || keys.indexOf(guess) > -1)) return guess;
		return "待定";
	}

	beat() {
		return normBeat(this.get(K.beat));
	}

	hasPM() {
		return !!String(this.get(K.pm)).trim();
	}

	hasConflict() {
		return !!String(this.get(K.conflict)).trim();
	}

	/* 手动尺寸：写死在卡上，不跟文字走 */
	width() {
		return Math.max(MIN_W, toInt(this.get(K.width), DEFAULT_W));
	}

	height() {
		return Math.max(MIN_H, toInt(this.get(K.height), DEFAULT_H));
	}

	hasSize() {
		return !!(String(this.get(K.width)).trim() || String(this.get(K.height)).trim());
	}

	/* 这一张卡在第几列（1 起）。
	   显式记住在第几列，而不是渲染时按顺序轮流分配 —— 那样一加列，
	   原来全在第 1 列的卡就被自动分到第 2、3 列去了（用户报的 bug）。
	   没写「列」字段 = 第 1 列；列数变少时只是显示上被夹住，字段不动，
	   所以把列数加回去，卡还会回到原来那一列。 */
	col(n) {
		const c = toInt(this.get(K.col), 1);
		const max = n && n > 0 ? n : MAX_COLS;
		return Math.min(Math.max(1, c), max);
	}

	setCol(c) {
		const v = toInt(c, 1);
		if (v <= 1) this.del(K.col);
		else this.set(K.col, String(Math.min(v, MAX_COLS)));
	}

	resolveColor(map) {
		const raw = String(this.get(K.color)).trim();
		if (!raw) return "";
		if (map && map[raw]) return map[raw];
		return autoColor(raw);
	}
}

/* ---------------------------------------------------------------- 案板元信息（幕 / 列数 / 铰链） */

/* ---------- 旧幕名迁移 ----------
   旧默认四幕（第一幕/第二幕上/第二幕下/第三幕）按位置映射到新四幕；
   只有 acts 恰好是旧默认四幕的板子才迁移（用户自定义幕名不动）。 */
const LEGACY_ACTS = ["第一幕", "第二幕上", "第二幕下", "第三幕"];
const LEGACY_ACT_MAP = { "第二幕上": "第二幕", "第二幕下": "第三幕", "第三幕": "第四幕" };

function migrateLegacyActs(meta, cards) {
	if (!meta || !Array.isArray(meta.acts)) return false;
	const keys = meta.acts.map((a) => a.key);
	if (keys.length !== LEGACY_ACTS.length || LEGACY_ACTS.some((k, i) => keys[i] !== k)) return false;
	meta.acts = meta.acts.map((a) => ({ key: LEGACY_ACT_MAP[a.key] || a.key, hinge: a.hinge }));
	meta.dirty = true;
	const list = meta.keys();
	for (const c of cards || []) {
		const cur = String(c.get(K.act)).trim();
		if (cur && LEGACY_ACT_MAP[cur] && list.indexOf(LEGACY_ACT_MAP[cur]) > -1) {
			c.set(K.act, LEGACY_ACT_MAP[cur]);
		}
	}
	return true;
}

class BoardMeta {
	constructor() {
		this.acts = ACTS.map((a) => ({ key: a.key, hinge: HINGE[a.key] || "", notes: [], summary: true }));
		this.cols = ACTS.map(() => 1);
		this.summary = ACTS.map(() => true); // 每幕是否参与汇总（true=参与）
		this.dirty = false; // 用户改过幕或列数 → 需要写进文件
	}

	keys() {
		return this.acts.map((a) => a.key);
	}

	indexOf(key) {
		return this.keys().indexOf(key);
	}

	hingeOf(key) {
		const i = this.indexOf(key);
		return i >= 0 ? this.acts[i].hinge || "" : "";
	}

	/* ：这一幕是否参与汇总（缺省/未知都视为参与） */
	summaryOf(key) {
		const i = this.indexOf(key);
		return i >= 0 ? this.summary[i] !== false : true;
	}

	colsOf(key) {
		const i = this.indexOf(key);
		return i >= 0 ? clampCols(this.cols[i]) : 1;
	}

	setCols(key, n) {
		const i = this.indexOf(key);
		if (i < 0) return;
		this.cols[i] = clampCols(n);
		this.dirty = true;
	}

	/* 铰链 = 这一行末尾那张卡该是什么节拍（可自行在铰链里填写）。
	   它只是「终点标记」，不是一张卡，所以可以改也可以清空。 */
	setHinge(idx, name) {
		if (idx < 0 || idx >= this.acts.length) return false;
		this.acts[idx].hinge = String(name == null ? "" : name).trim();
		this.dirty = true;
		return true;
	}

	rename(idx, name) {
		const n = String(name || "").trim();
		if (idx < 0 || idx >= this.acts.length || !n) return false;
		if (this.keys().some((k, i) => i !== idx && k === n)) return false;
		this.acts[idx].key = n;
		this.dirty = true;
		return true;
	}

	/* ：互换两幕的名字（改名撞名时用）。只换名字，卡不动——
	   卡片「幕」字段的对调由调用方一并处理。 */
	swapNames(idxA, idxB) {
		if (idxA < 0 || idxB < 0 || idxA === idxB) return false;
		if (idxA >= this.acts.length || idxB >= this.acts.length) return false;
		const k = this.acts[idxA].key;
		this.acts[idxA].key = this.acts[idxB].key;
		this.acts[idxB].key = k;
		this.dirty = true;
		return true;
	}

	addAct(name, summary) {
		let n = String(name || "").trim() || "新一幕";
		const base = n;
		let i = 2;
		while (this.keys().indexOf(n) > -1) {
			n = base + i;
			i++;
		}
		this.acts.push({ key: n, hinge: "", summary: summary !== false });
		this.cols.push(1);
		this.summary.push(summary !== false);
		this.dirty = true;
		return n;
	}

	removeAct(idx) {
		if (this.acts.length <= 1) return false;
		if (idx < 0 || idx >= this.acts.length) return false;
		this.acts.splice(idx, 1);
		this.cols.splice(idx, 1);
		this.summary.splice(idx, 1);
		this.dirty = true;
		return true;
	}

	moveAct(idx, dir) {
		const j = idx + dir;
		if (idx < 0 || idx >= this.acts.length || j < 0 || j >= this.acts.length) return false;
		const a = this.acts[idx];
		this.acts[idx] = this.acts[j];
		this.acts[j] = a;
		const c = this.cols[idx];
		this.cols[idx] = this.cols[j];
		this.cols[j] = c;
		const s = this.summary[idx];
		this.summary[idx] = this.summary[j];
		this.summary[j] = s;
		this.dirty = true;
		return true;
	}

	/* ：把第 idx 幕整体移到第 targetIdx 幕的正下方 */
	moveActAfter(idx, targetIdx) {
		if (idx < 0 || targetIdx < 0) return false;
		if (idx >= this.acts.length || targetIdx >= this.acts.length) return false;
		if (idx === targetIdx) return false;
		const a = this.acts.splice(idx, 1)[0];
		const c = this.cols.splice(idx, 1)[0];
		const s = this.summary.splice(idx, 1)[0];
		let insertAt = targetIdx;
		if (idx < targetIdx) insertAt = targetIdx - 1; /* 前面抽掉一个，目标位置左移一格 */
		this.acts.splice(insertAt + 1, 0, a);
		this.cols.splice(insertAt + 1, 0, c);
		this.summary.splice(insertAt + 1, 0, s === undefined ? true : s);
		this.dirty = true;
		return true;
	}

	/* 自定义幕时，把节拍推导出来的默认幕按顺序映射到用户自己的幕上 */
	mapDefaultAct(defKey) {
		const keys = this.keys();
		if (keys.indexOf(defKey) > -1) return defKey;
		const i = ACT_KEYS.indexOf(defKey);
		if (i < 0) return "待定";
		return keys[Math.min(i, keys.length - 1)];
	}

	clone() {
		const m = new BoardMeta();
		m.acts = this.acts.map((a) => ({ key: a.key, hinge: a.hinge, summary: a.summary !== false }));
		m.cols = this.cols.slice();
		m.summary = this.summary.slice();
		m.dirty = this.dirty;
		return m;
	}
}

/* ---------------------------------------------------------------- 解析 / 序列化 */

function splitKV(line) {
	const m = /^\s*[-*+]\s{0,3}([^：:\s]{1,14})[：:]\s?([\s\S]*)$/.exec(line);
	if (!m) return null;
	const rawKey = m[1].trim();
	const key = KEY_ALIAS[rawKey] || rawKey;
	return { k: key, v: m[2].trim() };
}

function lookupCardStart(line) {
	const m = /^\s*#{2,4}\s*卡\s*(\d+)\s*(?:[·・|｜:：]\s*(.*))?$/.exec(line);
	if (!m) return null;
	return { num: parseInt(m[1], 10) || 0, suffix: (m[2] || "").trim() };
}

function parseCards(body) {
	const lines = String(body || "").split(/\r?\n/);
	const cards = [];
	let cur = null;
	let lastField = null; /* ：上一条字段行（用于并回缩进续行） */
	for (const ln of lines) {
		if (/^\s*<!--/.test(ln)) {
			/* 元信息注释行不属于任何一张卡 */
			cur = null;
			lastField = null;
			continue;
		}
		const st = lookupCardStart(ln);
		if (st) {
			cur = new Card();
			cards.push(cur);
			if (st.suffix) cur.set(K.beat, st.suffix);
			lastField = null;
			continue;
		}
		if (!cur) continue;
		/* （用户报·多行字段冲坏结构）：序列化时多行值从第二行起缩进两个
		   空格续写；这里把缩进续行并回上一字段，还原出真正的多行内容。
		   （放在空行判断之前——字段内的空行也带缩进，同样要保留） */
		if (lastField && /^[ \t]/.test(ln)) {
			const prev = cur.get(lastField);
			cur.set(lastField, (prev ? prev + "\n" : "") + ln.replace(/^[ \t]{1,2}/, "").replace(/\s+$/, ""));
			continue;
		}
		if (!ln.trim()) continue;
		const kv = splitKV(ln);
		if (kv) {
			cur.set(kv.k, kv.v);
			lastField = kv.k;
		} else {
			/* （用户报·修复历史坏数据）：旧版把多行「事」写成不带缩进的
			   游离行，再解析时全被挤到卡尾 notes（内容看起来跑到 ＋/－/＞＜ 下面）。
			   卡上有「事」字段就把游离行还给它；否则照旧存进 notes。 */
			const hasAction = cur.fields.some((x) => x.k === K.action);
			if (hasAction) {
				const prevA = cur.get(K.action);
				cur.set(K.action, (prevA ? prevA + "\n" : "") + ln.replace(/\s+$/, ""));
			} else {
				cur.notes.push(ln.replace(/\s+$/, ""));
			}
			lastField = null;
		}
	}
	return cards;
}

function serializeCard(card, no) {
	const beat = card.beat();
	const head = "### 卡" + no + (beat ? " · " + beat : "");
	const lines = [head];
	for (const f of card.fields) {
		if (!f.k) continue;
		if (f.k === K.beat && !f.v) continue;
		/* （用户报）：字段值里的换行会把卡片字段结构冲坏——多行「事」写回
		   文件后，第二行起变成游离行，再解析时全被挤到卡尾（＋/－/＞＜ 下面），
		   内容看起来「保存了却读不回来」。现在多行值从第二行起缩进两个空格续写，
		   解析时再并回原字段，结构稳定不坏。 */
		const parts = String(f.v == null ? "" : f.v).split(/\r?\n/);
		lines.push("- " + f.k + "：" + parts[0]);
		for (let i = 1; i < parts.length; i++) lines.push("  " + parts[i]);
	}
	for (const n of card.notes) lines.push(n);
	return lines.join("\n");
}

/* ---------- 卡片编号 ----------
   节拍为「导语」的卡编号固定 00、不占位数；
   其余卡按数组顺序跳过导语卡连续编号（01、02…）。
   汇总导出（知乎风）再去掉前导零（01 → 1，00 → 0）。 */
const PROLOGUE_BEAT = "导语";

function isPrologueCard(c) {
	return !!c && normBeat(c.get(K.beat)) === PROLOGUE_BEAT;
}

function cardNoOf(cards, idx) {
	const list = Array.isArray(cards) ? cards : [];
	const c = list[idx];
	if (c && isPrologueCard(c)) return "00";
	let n = 0;
	for (let i = 0; i <= idx; i++) {
		if (list[i] && !isPrologueCard(list[i])) n++;
	}
	return pad2(n);
}

/* （用户要求）：编号 = **板面视觉顺序**——幕从上到下、幕内先第 1 列从上到下、
   再第 2 列……排完一幕再下一幕。卡片挪位置，编号跟着**位置**重新分配；
   历史数据（文件里的先后、旧列字段）不影响编号。导语卡固定 00、不占号。 */
function buildNoMap(cards, meta) {
	const map = new Map();
	const list = Array.isArray(cards) ? cards : [];
	if (!meta || !meta.keys) return map;
	const ks = meta.keys();
	let n = 0;
	const walk = (actKey, colCount) => {
		/* （用户报）：不参与汇总的幕，其卡片不编号、不占号——
		   参与汇总的卡序号连续，汇总导出的段落编号不再被"不汇总"幕顶断 */
		if (meta.summaryOf && meta.summaryOf(actKey) === false) return;
		const total = Math.max(1, colCount);
		for (let col = 1; col <= total; col++) {
			for (let i = 0; i < list.length; i++) {
				const c = list[i];
				if (c.act(ks) !== actKey) continue;
				if (Math.min(c.col(total), total) !== col) continue;
				if (isPrologueCard(c)) { map.set(c, "00"); continue; }
				n++;
				map.set(c, pad2(n));
			}
		}
	};
	for (const k of ks) walk(k, clampCols(meta.colsOf(k)));
	walk("待定", 3);
	return map;
}

function stripCardNo(no) {
	const n = parseInt(no, 10);
	return isNaN(n) ? String(no) : String(n);
}

/* 汇总导出（知乎风）：导语卡排最前（编号 0），其余按编号；只汇总写了「事」的卡 */
function summarizeCards(cards, meta, noMap) {
	const list = cards || [];
	const items = [];
	for (let i = 0; i < list.length; i++) {
		/* ：不参与汇总的幕，其卡片不进导出 */
		if (meta && meta.summaryOf && meta.summaryOf(list[i].act(meta.keys())) === false) continue;
		const txt = String(list[i].get(K.action) || "").trim();
		if (!txt) continue;
		items.push({ no: (noMap && noMap.get(list[i])) || cardNoOf(list, i), prologue: isPrologueCard(list[i]), text: txt });
	}
	items.sort((a, b) =>
		(a.prologue === b.prologue ? stripCardNo(a.no) - stripCardNo(b.no) : a.prologue ? -1 : 1)
	);
	return items.map((it) => stripCardNo(it.no) + "\n" + it.text).join("\n\n");
}

function splitMarks(raw) {
	const i = raw.indexOf(START_MARK);
	const j = raw.indexOf(END_MARK);
	if (i >= 0 && j > i) {
		return { head: raw.slice(0, i), tail: raw.slice(j + END_MARK.length), found: true };
	}
	return { head: raw.replace(/\s*$/, "") + "\n\n", tail: "\n", found: false };
}

function bodyOfRaw(raw) {
	const sp = splitMarks(raw);
	if (!sp.found) return raw;
	return raw.slice(raw.indexOf(START_MARK) + START_MARK.length, raw.indexOf(END_MARK));
}

function readMetaLine(body, tag) {
	const re = new RegExp("<!--\\s*stc:" + tag + "\\s*:([\\s\\S]*?)-->");
	const m = re.exec(String(body || ""));
	return m ? m[1].trim() : null;
}

function splitPipes(s) {
	return String(s == null ? "" : s)
		.split(/[|｜]/)
		.map((x) => x.trim());
}

/* 从案板正文里读出幕 / 列数 / 铰链。老文件没有这些行 → 默认四幕。 */
function parseMeta(body) {
	const meta = new BoardMeta();
	const rawActs = readMetaLine(body, "acts");
	if (rawActs === null) return meta;
	const names = splitPipes(rawActs).filter(Boolean);
	if (!names.length) return meta;
	const cols = splitPipes(readMetaLine(body, "cols") || "");
	const hinges = splitPipes(readMetaLine(body, "hinge") || "");
	meta.acts = names.map((n, i) => ({ key: n, hinge: hinges[i] || "", notes: [], summary: true }));
	meta.cols = names.map((n, i) => clampCols(cols[i]));
	meta.summary = names.map(() => true);
	/* ：幕头备注（文本域）。按幕的顺序存成 JSON 数组的数组，读写失败不影响使用 */
	try {
		const rawNotes = readMetaLine(body, "actnotes");
		if (rawNotes) {
			const arr = JSON.parse(rawNotes);
			if (Array.isArray(arr)) {
				meta.acts.forEach((a, i) => {
					if (Array.isArray(arr[i])) a.notes = arr[i].map((x) => String(x));
				});
			}
		}
	} catch (e) {
		/* 忽略格式问题 */
	}
	/* ：每幕是否参与汇总（0=不参与，其余=参与；缺省视为参与） */
	try {
		const rawSum = readMetaLine(body, "summary");
		if (rawSum) {
			const arr = splitPipes(rawSum).map((x) => x.trim() === "0" ? false : true);
			meta.acts.forEach((a, i) => {
				if (i < arr.length) a.summary = arr[i];
			});
			meta.summary = meta.acts.map((a) => a.summary !== false);
		}
	} catch (e) {
		/* 忽略格式问题 */
	}
	/* ：折叠状态（1=折叠，缺省=展开）。位置对应幕序 */
	try {
		const rawCollapsed = readMetaLine(body, "collapsed");
		if (rawCollapsed) {
			const arr = splitPipes(rawCollapsed).map((x) => x.trim() === "1");
			meta.acts.forEach((a, i) => {
				if (i < arr.length) a.collapsed = arr[i];
			});
		}
	} catch (e) {
		/* 忽略格式问题 */
	}
	return meta;
}

function serializeMeta(meta) {
	const lines = [
		"<!-- stc:acts: " + meta.acts.map((a) => a.key).join(" | ") + " -->",
		"<!-- stc:cols: " + meta.cols.map((n) => String(clampCols(n))).join(" | ") + " -->",
		"<!-- stc:hinge: " + meta.acts.map((a) => a.hinge || "").join(" | ") + " -->",
	];
	const anyNotes = meta.acts.some((a) => a.notes && a.notes.some((x) => String(x).trim()));
	if (anyNotes) {
		lines.push(
			"<!-- stc:actnotes: " +
				JSON.stringify(meta.acts.map((a) => (a.notes || []).map((x) => String(x)))) +
				" -->"
		);
	}
	/* ：只有出现「不参与汇总」的幕才写这一行，否则保持文件干净 */
	const anyExcluded = meta.acts.some((a) => a.summary === false);
	if (anyExcluded) {
		lines.push(
			"<!-- stc:summary: " + meta.acts.map((a) => (a.summary === false ? "0" : "1")).join(" | ") + " -->"
		);
	}
	/* ：折叠的幕（˄/˅）。位置对应幕序，1=折叠；没有折叠的幕就不写这行，保持文件干净 */
	const anyCollapsed = meta.acts.some((a) => a.collapsed);
	if (anyCollapsed) {
		lines.push("<!-- stc:collapsed: " + meta.acts.map((a) => (a.collapsed ? "1" : "0")).join(" | ") + " -->");
	}
	return lines.join("\n");
}

function cardsFromRaw(raw) {
	return parseCards(bodyOfRaw(raw));
}

function boardFromRaw(raw) {
	const body = bodyOfRaw(raw);
	return { cards: parseCards(body), meta: parseMeta(body) };
}

function hasMetaInFile(raw) {
	return /<!--\s*stc:(acts|cols|hinge)\s*:/.test(String(raw || ""));
}

/* ---------------------------------------------------------------- 统计 */

function computeStats(cards, meta) {
	meta = meta || new BoardMeta();
	const keys = meta.keys();
	const acts = [];
	for (const key of keys) {
		const list = cards.filter((c) => c.act(keys) === key);
		const def = ACTS.find((a) => a.key === key);
		acts.push({
			key: key,
			label: key,
			pages: def ? def.pages : "",
			count: list.length,
			cols: meta.colsOf(key),
			hinge: meta.hingeOf(key),
			lastBeat: list.length ? list[list.length - 1].beat() : "",
			hingeOk: false,
			excluded: !meta.summaryOf(key),
		});
		for (const a of acts) {
			a.hingeOk = !!(a.hinge && a.lastBeat && normBeat(a.lastBeat) === normBeat(a.hinge));
		}
	}
	const tray = cards.filter((c) => keys.indexOf(c.act(keys)) < 0);
	return {
		acts: acts,
		keys: keys,
		tray: tray,
		total: cards.length,
		missingPM: cards.filter((c) => !c.hasPM()).length,
		missingCF: cards.filter((c) => !c.hasConflict()).length,
	};
}

/* --------- 卡片体检：把对索引卡的硬要求做成可校验项 ---------
   1. 一卡 = 一个场景：场头只写一处「内外景 + 地点 + 日夜」
   2. 一句话动作
   3. ＋/－：只允许**一次**转变（开头基调 → 结尾基调，二者必须相反）
   4. ＞＜：只允许**一个**冲突（谁反对谁、谁赢）
   -------------------------------------------------------------------- */

/* 「段落卡」：书里说"一个段落有五六张甚至七张卡…没关系，最终会合成到一张卡上"。
   在「场」或「备」里写明「段落」即声明为段落卡。 */
function isParagraphCard(card) {
	return /段落/.test(String(card.get(K.scene)) + String(card.get(K.note)));
}

function checkCard(card) {
	const out = [];
	/* ：导语卡是特型卡（引子，本就没有场景），不参与四条硬要求检查 */
	if (isPrologueCard(card)) return out;
	if (!String(card.get(K.scene)).trim()) out.push("没写「场」（内/外景 + 地点 + 日夜）");
	else if (!isParagraphCard(card) && sepCount(card.get(K.scene), "→｜|／/") > 0)
		out.push("「场」里像是有不止一个场景（出现了 → / ｜ / ／）；一卡只放一个场景，段落卡请在「场」或「备」里写明「段落」");
	if (!String(card.get(K.action)).trim()) out.push("没写「事」（要能看出开端、发展、结局）");

	if (!card.hasPM()) out.push("缺 ＋/－（情绪没有转变，说明这场戏还没想清楚）");
	else {
		const p = pmParts(card.get(K.pm));
		if (p.ok) {
			if (!p.from || !p.to) out.push("＋/－ 的开头基调和结尾基调都要选上");
			else if (p.from === p.to) out.push("＋/－ 开头和结尾一样（都是 " + p.from + "），等于没转变，必须相反");
		} else {
			const n = countArrows(pmLead(card.get(K.pm)));
			if (n === 0) out.push("＋/－ 里没看到转变箭头（写法：「开头基调 → 结尾基调｜说明」，两者必须相反）");
			else if (n > 1) out.push("＋/－ 的开头→结尾有 " + n + " 次转变，一卡只准一次");
		}
	}

	if (!card.hasConflict()) out.push("缺 ＞＜（找不到冲突就扔掉这张卡）");
	else {
		const vs = String(card.get(K.conflict)).match(/vs/gi);
		if (vs && vs.length > 1) out.push("＞＜ 里有 " + vs.length + " 处冲突，一个场景只要一个冲突");
	}
	return out;
}

function validate(cards, opts) {
	opts = opts || {};
	const meta = opts.meta || new BoardMeta();
	const st = computeStats(cards, meta);
	const warns = [];

	/* （用户要求）：卡数检查（每行目标卡数 / 总卡数目标）已整体移除——
	   不再按张数报「超过/低于目标」，也不再报黑洞。 */
	for (const a of st.acts) {
		if (a.count === 0) warns.push(a.key + "：这一行还没有卡");
		if (a.hinge && a.lastBeat && !a.hingeOk && isTerminator(a.lastBeat) === false) {
			warns.push(a.key + " 行末的铰链应是「" + a.hinge + "」，当前末卡节拍是「" + a.lastBeat + "」");
		}
	}
	if (st.tray.length) warns.push("有 " + st.tray.length + " 张卡还没归行（收卡盘）");

	const bad = [];
	cards.forEach((c, i) => {
		const p = checkCard(c);
		if (p.length) bad.push("卡" + pad2(i + 1) + "（" + (c.beat() || "无节拍") + "）：" + p.join("；"));
	});
	if (bad.length) {
		warns.push("有 " + bad.length + " 张卡还不合规，不能算上板：");
		for (const b of bad) warns.push("    · " + b);
	}
	return warns;
}

/* 落点判定：卡片中腹 = 互换；靠边 = 插到前面 / 后面。
   以前只有「插入」一种，所以两张卡永远换不了位置（用户报的）。
   注：竖排的列里，靠上/下边是主要情况；横着靠边时按左右判前后。 */
function dropMode(el, e) {
	const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
	if (!r) return "before";
	const h = Math.max(1, r.height);
	/* 列里卡片是**竖着排**的，所以只看上下：
	   上边 26% = 插到它前面，下边 26% = 插到它后面，中间 48% = 互换。
	   （以前还掺了左右，落到四角时会出现「明明想插到下面却判成插到上面」。） */
	const ry = (e.clientY - r.top) / h;
	const ey = Math.min(ry, 1 - ry);
	if (ey >= SWAP_ZONE) return "swap";
	return ry < 0.5 ? "before" : "after";
}

/* ---------------------------------------------------------------- 新建案板模板 */

function newBoardTemplate(title) {
	const t = title || "未命名";
	const lines = [];
	lines.push("---");
	lines.push("type: xw-card-board");
	lines.push("title: 案板_" + t);
	lines.push("---");
	lines.push("");
	lines.push("# 案板 · " + t);
	lines.push("");
	lines.push("> **看板面看下面这个框**（阅读模式下就是可以拖动、编辑的案板）：");
	lines.push("");
	lines.push("```xw-card-board");
	lines.push("```");
	lines.push("");
	lines.push("> 再往下是这张案板的**数据本体**，插件直接读写它，不用手改。");
	lines.push("> 每张卡 = 一个场景：内/外景 + 地点 + 日夜 ｜ 一句话动作 ｜ ＋/－ 一次转变 ｜ ＞＜ 一个冲突 ｜ 宽/高（手动尺寸）。");
	lines.push("> 先按「一个场景一张卡」往板上铺，需要的话再按自己的判据精减。找不到冲突就扔掉这张卡。");
	lines.push("");
	lines.push(START_MARK);
	lines.push("");
	lines.push(END_MARK);
	return lines.join("\n");
}

/* （用户要求）：导入模板的**纯函数**——原样复制幕布布局＋卡片布局：
   幕名/顺序/列数/铰链 + 每张卡的 幕/列/宽/高/节拍/场（场常用来写标题， 起保留）；卡片内容（事/＋－/＞＜/色）
   不带走（幕头备注  起随模板一并导入）。返回 { meta, cards }，由调用方写进当前案板。 */
function cloneBoardLayout(srcCards, srcMeta) {
	const meta = srcMeta.clone();
	meta.dirty = true;
	/* （用户要求）：幕头备注（如 Who/Why/What/How 这类提示）也是模板的一部分，一并导入 */
	meta.acts.forEach((a, i) => {
		const src = srcMeta.acts[i];
		a.notes = src && Array.isArray(src.notes) ? src.notes.map((x) => String(x)) : [];
		a.collapsed = false; /* ：折叠是个人浏览状态，不随模板导入 */
	});
	const cards = (Array.isArray(srcCards) ? srcCards : []).map((c) => {
		const n = new Card();
		n.set(K.act, c.get(K.act));
		n.set(K.beat, c.get(K.beat));
		n.set(K.scene, c.get(K.scene)); /* （用户要求）：「场」保留——常用来写标题 */
		n.set(K.width, c.get(K.width));
		n.set(K.height, c.get(K.height));
		n.setCol(c.col(MAX_COLS));
		return n;
	});
	return { meta, cards };
}
function beatAnchorCards(meta) {
	const plan = [
		["", "第一幕"], ["", "第一幕"], ["", "第一幕"], ["", "第一幕"],
		["", "第二幕"], ["", "第二幕"], ["", "第二幕"], ["", "第二幕"],
		["", "第三幕"], ["", "第三幕"], ["", "第三幕"], ["", "第三幕"],
		["", "第四幕"], ["", "第四幕"], ["", "第四幕"],
	];
	const m = meta || new BoardMeta();
	return plan.map(([beat, act]) => {
		const c = new Card();
		c.set(K.act, m.mapDefaultAct(act));
		c.set(K.beat, beat);
		c.set(K.scene, "");
		c.set(K.action, "");
		c.set(K.pm, "");
		c.set(K.conflict, "");
		return c;
	});
}

/* ---------------------------------------------------------------- 选择文件 */

class BoardFileModal extends FuzzySuggestModal {
	constructor(app, plugin, opts) {
		super(app);
		this.plugin = plugin;
		this.opts = opts || {};
		this.setPlaceholder(
			this.opts.pickTitle || "选择案板文件（带 type: xw-card-board 的会排在前面）……"
		);
	}

	getItems() {
		const files = this.app.vault.getMarkdownFiles();
		const boards = [];
		const others = [];
		for (const f of files) {
			const cache = this.app.metadataCache.getFileCache(f);
			const fm = cache && cache.frontmatter;
			const isBoard = fm && (fm.type === "xw-card-board" || fm["type"] === "xw-card-board");
			if (isBoard) boards.push(f);
			else others.push(f);
		}
		return boards.concat(others);
	}

	getItemText(f) {
		return f.path;
	}

	onChooseItem(f) {
		/* ：也能当「模板选择器」用——传入 onPick 就把选中的文件交给调用方 */
		if (this.opts && this.opts.onPick) {
			this.opts.onPick(f);
			return;
		}
		this.plugin.setBoardFile(f.path);
	}
}

/* ---------------------------------------------------------------- 单行文字输入弹窗 */

class TextPromptModal extends Modal {
	constructor(app, opts) {
		super(app);
		opts = opts || {};
		this.title = opts.title || "输入";
		this.desc = opts.desc || "";
		this.value = opts.value || "";
		this.placeholder = opts.placeholder || "";
		this.onSubmit = opts.onSubmit || function () {};
	}

	onOpen() {
		const root = this.contentEl;
		root.addClass("stc-modal");
		root.createEl("h3", { text: this.title });
		if (this.desc) root.createEl("div", { cls: "stc-hint", text: this.desc });
		const wrap = root.createDiv({ cls: "stc-field" });
		const input = wrap.createEl("input", { type: "text", cls: "stc-input" });
		input.value = this.value;
		if (this.placeholder) input.placeholder = this.placeholder;

		const btns = root.createDiv({ cls: "stc-modal-btns" });
		const ok = btns.createEl("button", { text: "确定", cls: "mod-cta" });
		const cancel = btns.createEl("button", { text: "取消" });
		const submit = () => {
			const v = input.value.trim();
			this.close();
			this.onSubmit(v);
		};
		ok.addEventListener("click", submit);
		cancel.addEventListener("click", () => this.close());
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});
		window.setTimeout(() => input.focus(), 30);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ：加一幕弹窗——幕名输入 + 汇总参与滑块开关（右=参与，左=不参与，默认参与） */
class AddActModal extends Modal {
	constructor(app, onSubmit) {
		super(app);
		this.onSubmit = onSubmit || function () {};
		this.summary = true;
	}

	onOpen() {
		const root = this.contentEl;
		root.addClass("stc-modal");
		root.createEl("h3", { text: "加一幕" });
		root.createEl("div", {
			cls: "stc-hint",
			text: "幕名随便写——不一定是「第一幕」。比如「前史」「支线」「番外」。",
		});
		const wrap = root.createDiv({ cls: "stc-field" });
		const input = wrap.createEl("input", { type: "text", cls: "stc-input" });
		input.placeholder = "例如：前史";

		const swRow = root.createDiv({ cls: "stc-addact-sum" });
		swRow.createEl("span", { text: "参与汇总：" });
		const sw = swRow.createEl("label", { cls: "stc-switch" });
		const swInput = sw.createEl("input", { type: "checkbox" });
		swInput.checked = true; /* 默认参与 */
		const swTrack = sw.createEl("span", { cls: "stc-switch-track" });
		swTrack.createEl("span", { cls: "stc-switch-knob" });
		swInput.addEventListener("change", () => {
			this.summary = !!swInput.checked;
		});

		const btns = root.createDiv({ cls: "stc-modal-btns" });
		const ok = btns.createEl("button", { text: "确定", cls: "mod-cta" });
		const cancel = btns.createEl("button", { text: "取消" });
		const submit = () => {
			const v = input.value.trim();
			this.close();
			if (v) this.onSubmit(v, this.summary);
		};
		ok.addEventListener("click", submit);
		cancel.addEventListener("click", () => this.close());
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});
		window.setTimeout(() => input.focus(), 30);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ---------------------------------------------------------------- 编辑卡片的弹窗 */

class CardModal extends Modal {
	constructor(app, plugin, card, meta, onSave, onDelete) {
		super(app);
		this.plugin = plugin;
		this.card = card;
		this.meta = meta || new BoardMeta();
		this.onSave = onSave;
		this.onDelete = onDelete;
		/* （用户报）：保存时若什么都没改，就只关窗——不去动板面（不重绘=不弹跳） */
		this._changed = false;
	}

	onOpen() {
		const root = this.contentEl;
		root.addClass("stc-modal");
		root.createEl("h3", { text: "索引卡" });
		/* 任何输入/选择都算「改过」（input/change 都会冒泡到根上，一处监听全覆盖） */
		root.addEventListener("input", () => (this._changed = true));
		root.addEventListener("change", () => (this._changed = true));

		/* ---- 幕 ---- */
		const actField = root.createDiv({ cls: "stc-field" });
		actField.createEl("label", { text: "幕" });
		const actSel = actField.createEl("select", { cls: "stc-input stc-act-sel" });
		const keysNow = this.meta.keys();
		const rawAct = String(this.card.get(K.act)).trim();

		/* 不填「幕」时按节拍自动归行，所以这里把推导结果直接写在选项上，
		   省得用户选了「自动」却不知道会落到哪一行。（自定义节拍模板也认） */
		const autoAct = beatActOf(this.card.get(K.beat))
			? this.meta.mapDefaultAct(beatActOf(this.card.get(K.beat)))
			: "待定";

		const opt = (label, value) => {
			const o = actSel.createEl("option", { text: label });
			o.value = value;
		};
		opt(rawAct ? "（按节拍自动）" : "（按节拍自动 → " + autoAct + "）", "");
		keysNow.forEach((k, i) => opt(i + 1 + ". " + k, k));
		opt("待定（收卡盘）", "待定");
		if (rawAct && keysNow.indexOf(rawAct) < 0 && rawAct !== "待定") opt("（当前值）" + rawAct, rawAct);
		actSel.value = rawAct && (keysNow.indexOf(rawAct) > -1 || rawAct === "待定") ? rawAct : "";
		actSel.addEventListener("change", () => this.card.set(K.act, actSel.value));

		/* ---- 节拍 ---- */
		const beatBox = root.createDiv({ cls: "stc-field" });
		beatBox.createEl("label", { text: "节拍" });
		const beatSel = beatBox.createEl("select", { cls: "stc-input stc-beat-in" });
		const curBeat = String(this.card.get(K.beat)).trim();
		const normed = normBeat(curBeat);
		const beatList = [""].concat(BEATS).concat(customBeatNames(this.plugin.settings));
		if (curBeat && beatList.indexOf(curBeat) < 0 && beatList.indexOf(normed) < 0) beatList.push(curBeat);
		for (const b of beatList) {
			const o = beatSel.createEl("option", { text: b === "" ? "（不填）" : b });
			o.value = b;
		}
		if (!curBeat) beatSel.value = "";
		else beatSel.value = BEATS.indexOf(normed) > -1 ? normed : curBeat;
		beatSel.addEventListener("change", () => {
			this.card.set(K.beat, beatSel.value);
			paintBeatDesc();
		});
		const beatDescEl = beatBox.createEl("div", { cls: "stc-hint stc-beat-desc" });
		const paintBeatDesc = () => {
			const d = beatDesc(beatSel.value);
			beatDescEl.setText(d ? d : "——");
		};
		paintBeatDesc();
		beatBox.createEl("div", {
			cls: "stc-hint",
			text: "下拉里默认只有「（不填）」，后面跟着你在设置里加的自定义节拍模板（如角色卡）。",
		});

		/* ---- 场 ---- */
		const sceneBox = root.createDiv({ cls: "stc-field" });
		sceneBox.createEl("label", { text: "场（内/外景 + 地点 + 日/夜）" });
		const sceneIn = sceneBox.createEl("input", { type: "text", cls: "stc-input stc-scene-in" });
		sceneIn.value = this.card.get(K.scene);
		sceneIn.placeholder = "内景 乔的房间 日";
		sceneIn.addEventListener("input", () => this.card.set(K.scene, sceneIn.value.trim()));

		/* ---- 事 ---- */
		const actBox = root.createDiv({ cls: "stc-field" });
		actBox.createEl("label", { text: "事（必须有开端、发展和结局）" });
		const actIn = actBox.createEl("textarea", { cls: "stc-input stc-action-in" });
		actIn.rows = 2;
		actIn.value = this.card.get(K.action);
		actIn.placeholder = "林川勇敢地面对苏晴的秘密。";
		actIn.addEventListener("input", () => this.card.set(K.action, actIn.value.trim()));

		/* ---- ＋/－：点选，不用自己敲符号 ---- */
		const pmBox = root.createDiv({ cls: "stc-field" });
		pmBox.createEl("label", { text: "＋/－（情绪转变）" });
		const p0 = pmParts(this.card.get(K.pm));
		const pmRow = pmBox.createDiv({ cls: "stc-pm-row" });
		/* 只负责造下拉；change 处理在下面统一挂（之前这里多传了个 undefined 进去） */
		const mkDir = (val) => {
			const sel = pmRow.createEl("select", { cls: "stc-input stc-dir" });
			for (const v of ["", "＋", "－"]) {
				const o = sel.createEl("option", { text: v === "" ? "（未选）" : v });
				o.value = v;
			}
			sel.value = val;
			return sel;
		};
		const fromSel = mkDir(p0.from);
		pmRow.createEl("span", { cls: "stc-arrow", text: "→" });
		const toSel = mkDir(p0.to);
		const pmHint = pmBox.createEl("div", {
			cls: "stc-hint",
			text: "开头基调 → 结尾基调，两个必须相反（＋ → － 或 － → ＋），一个场景只准一次。",
		});
		const pmNoteLine = pmBox.createDiv({ cls: "stc-cf-line" });
		pmNoteLine.createEl("span", { cls: "stc-cf-tag", text: "情绪变化" });
		const pmNote = pmNoteLine.createEl("input", { type: "text", cls: "stc-input stc-pm-note" });
		pmNote.value = p0.note;
		pmNote.placeholder = "林川满怀希望，以为能问出秘密；苏晴拒绝/不能告诉他，林川失望离开";
		const syncPM = () => {
			this.card.set(K.pm, pmText(fromSel.value, toSel.value, pmNote.value));
			pmHint.setText(
				fromSel.value && toSel.value
					? fromSel.value === toSel.value
						? "开头和结尾一样，等于没转变——改一个吧。"
						: "现在是 " + fromSel.value + " → " + toSel.value + "，可以。"
					: "开头基调 → 结尾基调，两个必须相反（＋ → － 或 － → ＋），一个场景只准一次。"
			);
			if (fromSel.value && toSel.value && fromSel.value === toSel.value) pmHint.addClass("stc-bad-text");
			else pmHint.removeClass("stc-bad-text");
		};
		fromSel.addEventListener("change", syncPM);
		toSel.addEventListener("change", syncPM);
		pmNote.addEventListener("input", () => this.card.set(K.pm, pmText(fromSel.value, toSel.value, pmNote.value)));
		if (!p0.ok && String(this.card.get(K.pm)).trim()) {
			pmBox.createEl("div", {
				cls: "stc-hint",
				text: "上面这行说明是从旧写法读出来的。选好开头/结尾基调，它就会变成规范写法。",
			});
		}
		syncPM();

		/* ---- ＞＜：点选 ---- */
		const cfBox = root.createDiv({ cls: "stc-field" });
		cfBox.createEl("label", { text: "＞＜（冲突）" });
		const c0 = cfParts(this.card.get(K.conflict));
		const cfSelf = this;
		/* 第一行：谁 vs 谁 */
		const cfVs = cfBox.createDiv({ cls: "stc-cf-line" });
		const aIn = cfVs.createEl("input", { type: "text", cls: "stc-input stc-cf-a" });
		aIn.value = c0.a;
		aIn.placeholder = "谁";
		cfVs.createEl("span", { cls: "stc-vs", text: "vs" });
		const bIn = cfVs.createEl("input", { type: "text", cls: "stc-input stc-cf-b" });
		bIn.value = c0.b;
		bIn.placeholder = "谁";
		/* 第二行：冲突点 / 第三行：结果 */
		const mkCfLine = (tag, cls) => {
			const line = cfBox.createDiv({ cls: "stc-cf-line" });
			line.createEl("span", { cls: "stc-cf-tag", text: tag });
			return line.createEl("input", { type: "text", cls: "stc-input " + cls });
		};
		const wIn = mkCfLine("冲突点", "stc-cf-w");
		wIn.value = c0.point;
		wIn.placeholder = "林川想知道秘密；苏晴不能/不愿说。";
		const nIn = mkCfLine("结果", "stc-cf-n");
		nIn.value = c0.result;
		nIn.placeholder = "苏晴守住秘密，林川没得到答案。";

		/* 没动过就沿用旧标签（老卡片读出来一字不改）；一动就换成新标签 */
		let pointLabel = c0.pointLabel;
		let resultLabel = c0.resultLabel;
		const syncCF = () => {
			cfSelf.card.set(K.conflict, cfText(aIn.value, bIn.value, wIn.value, nIn.value, pointLabel, resultLabel));
		};
		aIn.addEventListener("input", syncCF);
		bIn.addEventListener("input", syncCF);
		wIn.addEventListener("input", () => {
			pointLabel = "冲突点";
			syncCF();
		});
		nIn.addEventListener("input", () => {
			resultLabel = "结果";
			syncCF();
		});
		cfBox.createEl("div", {
			cls: "stc-hint",
			text: "谁反对谁、冲突点是什么、结果如何。一个场景只要一个冲突——找不到冲突就创造，创造不出来就扔掉这张卡。",
		});

		/* ---- 色：下拉选择 + 加 / 删 ---- */
		const colorBox = root.createDiv({ cls: "stc-field" });
		colorBox.createEl("label", { text: "色（色彩编码 / 这条线是谁的）" });
		const colorRow = colorBox.createDiv({ cls: "stc-color-row" });
		const dot = colorRow.createEl("span", { cls: "stc-dot-preview" });
		const colorSel = colorRow.createEl("select", { cls: "stc-input stc-color-sel" });
		const bNewColor = colorRow.createEl("button", { cls: "stc-mini-action", text: "＋ 新颜色" });
		const bDelColor = colorRow.createEl("button", { cls: "stc-mini-action", text: "－ 删颜色" });

		const paintDot = () => {
			const c = this.card.resolveColor(this.plugin.colorMapObj());
			dot.style.background = c || "transparent";
			dot.style.borderColor = c ? c : "var(--background-modifier-border)";
		};
		/* 重建下拉：加/删颜色之后调它，卡片弹窗不会关 */
		const fillColors = () => {
			const cur = String(this.card.get(K.color)).trim();
			const names = this.plugin.colorNames(cur);
			colorSel.empty();
			const none = colorSel.createEl("option", { text: "（不上色）" });
			none.value = "";
			for (const n of names) {
				const o = colorSel.createEl("option", { text: n });
				o.value = n;
			}
			colorSel.value = cur && names.indexOf(cur) > -1 ? cur : "";
			paintDot();
		};
		fillColors();

		/* 加一条线：只加，**不关这张卡**（用户报的 bug：加完颜色弹窗就没了，还没填完） */
		bNewColor.addEventListener("click", () => {
			new TextPromptModal(this.app, {
				title: "加一条线（人物 / 线索）",
				desc: "写个名字。选完这张卡还开着，接着填就行；颜色到插件设置 → 色彩编码表里指定。",
				placeholder: "例如：主角、女主、反派、伏笔A",
				onSubmit: async (v) => {
					if (!v) return;
					const t = String(v).trim();
					if (!t) return;
					this.card.set(K.color, t);
					await this.plugin.ensureColorName(t);
					fillColors();
					new Notice("已加「" + t + "」这条线。这张卡还开着，接着填。");
				},
			}).open();
		});

		/* 删颜色：把这条线从「色彩编码表」里去掉（卡片本身也顺手清掉） */
		bDelColor.addEventListener("click", async () => {
			const name = colorSel.value;
			if (!name) {
				new Notice("先在左边选一条线，再点「－ 删颜色」。");
				return;
			}
			const hit = await this.plugin.removeColorName(name);
			if (this.card.get(K.color) === name) this.card.set(K.color, "");
			fillColors();
			new Notice(
				hit
					? "已把「" + name + "」从色彩编码表里删掉。用这个名字的卡会回到自动色。"
					: "「" + name + "」本来就没有指定颜色（走的是自动色），没东西可删。"
			);
		});

		colorSel.addEventListener("change", () => {
			this.card.set(K.color, colorSel.value);
			paintDot();
		});
		colorBox.createEl("div", {
			cls: "stc-hint",
			text:
				"这里选的是「这条线是谁的」。具体什么颜色在插件设置 → 色彩编码表里改（那里点色块就能换）。" +
				"没指定的名字会自动分一个稳定颜色。「＋ 新颜色」加新的，「－ 删颜色」把当前这条从色表里去掉。",
		});

		/* ---- 备 ---- */
		const noteBox = root.createDiv({ cls: "stc-field" });
		noteBox.createEl("label", { text: "备（备注，可选）" });
		const noteIn = noteBox.createEl("input", { type: "text", cls: "stc-input stc-note-in" });
		noteIn.value = this.card.get(K.note);
		noteIn.placeholder = "写「段落」两个字，这张卡就算「段落卡」（可以跨地点）";
		noteIn.addEventListener("input", () => this.card.set(K.note, noteIn.value.trim()));
		/* （用户要求）：「源」功能整体移除（拆书溯源字段，实际用不上） */

		/* ---- 尺寸 ---- */
		const sizeRow = root.createDiv({ cls: "stc-size-row" });
		const wCol = sizeRow.createDiv({ cls: "stc-field" });
		wCol.createEl("label", { text: "宽（像素）" });
		const wPx = wCol.createEl("input", { type: "number", cls: "stc-input stc-w-px" });
		wPx.min = String(MIN_W);
		wPx.step = "10";
		wPx.value = String(this.card.width());
		wPx.addEventListener("input", () => this.card.set(K.width, String(Math.max(MIN_W, toInt(wPx.value, DEFAULT_W)))));
		const hCol = sizeRow.createDiv({ cls: "stc-field" });
		hCol.createEl("label", { text: "高（像素）" });
		const hPx = hCol.createEl("input", { type: "number", cls: "stc-input stc-h-px" });
		hPx.min = String(MIN_H);
		hPx.step = "10";
		hPx.value = String(this.card.height());
		hPx.addEventListener("input", () => this.card.set(K.height, String(Math.max(MIN_H, toInt(hPx.value, DEFAULT_H)))));
		sizeRow.createEl("div", {
			cls: "stc-hint",
			text: "尺寸写死在卡上，不跟文字走——内容放不下就在案板上拖右下角把它拉大。",
		});

		/* ---- 按钮 ---- */
		const btns = root.createDiv({ cls: "stc-modal-btns" });
		const save = btns.createEl("button", { text: "保存", cls: "mod-cta" });
		save.addEventListener("click", () => {
			this.close();
			/* （用户报）：没改任何内容时直接结束——板面完全不重绘，页面不会弹 */
			if (this._changed) this.onSave();
		});
		const del = btns.createEl("button", { text: "删除这张卡" });
		del.addEventListener("click", () => {
			this.close();
			this.onDelete();
		});
		const cancel = btns.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ---------------------------------------------------------------- 案板引擎
   不依赖 ItemView，因此既能挂在侧栏面板里，也能直接渲染进笔记的代码块。 */

class BoardEngine {
	constructor(plugin, container, opts) {
		opts = opts || {};
		this.plugin = plugin;
		this.app = plugin.app;
		this.root = container;
		this.filePath = opts.filePath || null;
		this.inline = !!opts.inline;
		this.cards = [];
		this.meta = new BoardMeta();
		this.dragIndex = -1;
		this.dropMark = null;
		this.suppressClick = false;
	}

	file() {
		const app = this.app || (this.plugin && this.plugin.app);
		if (!app || !app.vault) return null;
		const p = this.filePath || (this.plugin.settings && this.plugin.settings.boardFile);
		if (!p) return null;
		const f = app.vault.getAbstractFileByPath(normalizePath(p));
		return f instanceof TFile ? f : null;
	}

	keys() {
		return this.meta.keys();
	}

	async load() {
		if (this.plugin && this.plugin.engines) this.plugin.engines.add(this);
		this.cards = [];
		this.meta = new BoardMeta();
		const f = this.file();
		if (!f) return;
		try {
			const b = boardFromRaw(await this.app.vault.read(f));
			this.cards = b.cards;
			this.meta = b.meta;
			/* ：卡片数组按幕的显示顺序重排，卡号/文件序/汇总序和板面一致 */
			this.sortCardsByActs();
			/* （用户指定）：旧幕名是错的，打开旧默认四幕的板子时
			   自动改名（第二幕上/下 → 第二幕/第三幕…）并写回文件。 */
			if (migrateLegacyActs(this.meta, this.cards)) {
				try {
					const raw = await this.app.vault.read(f);
					const sp = splitMarks(raw);
					const body = (() => { const nm = buildNoMap(this.cards, this.meta); return this.cards.map((c) => serializeCard(c, nm.get(c) || cardNoOf(this.cards, this.cards.indexOf(c)))); })().join("\n\n");
					const out =
						sp.head +
						START_MARK +
						"\n\n" +
						serializeMeta(this.meta) +
						"\n\n" +
						body +
						(body ? "\n\n" : "") +
						END_MARK +
						sp.tail;
					this._writing = true;
					await this.app.vault.modify(f, out);
					const self = this;
					window.setTimeout(function () {
						self._writing = false;
					}, 400);
					new Notice("旧幕名已迁移：第二幕上/下 → 第二幕/第三幕（文件已写回）。");
				} catch (e2) {
					/* 迁移写回失败不影响正常使用，下次打开再试 */
				}
			}
		} catch (e) {
			new Notice("读取案板失败：" + e.message);
		}
		/* （用户报·防丢卡）：记录本引擎已同步到的文件时间，persist 的守卫要用 */
		this._syncedMtime = f && f.stat ? f.stat.mtime : 0;
	}

	/* （用户要求）：冲突时可选择谁覆盖谁——persist(true) = 以我为准强制覆盖文件；
	   默认（无参）仍受防丢卡守卫保护。 */
	async persist(force) {
		const f = this.file();
		if (!f) {
			new Notice("还没有选案板文件");
			return false;
		}
		/* （用户报·防丢卡）：写回前检查文件是否被其他窗口/分区抢先修改过。
		   改过就不静默覆盖（静默覆盖正是丢卡的根源），提示先「重新读取」。 */
		if (!force && this._syncedMtime && f.stat && f.stat.mtime > this._syncedMtime + 1000) {
			new Notice(
				"检测到案板文件刚被别处修改过，本次没有自动写入（防覆盖丢卡）。要谁覆盖谁你来定：点「保存」两次＝以我为准覆盖文件；点「重新读取」两次＝以文件为准。"
			);
			this._pendingLoss = true;
			return false;
		}
		this._writing = true;
		try {
			const raw = await this.app.vault.read(f);
			const sp = splitMarks(raw);
			const body = (() => { const nm = buildNoMap(this.cards, this.meta); return this.cards.map((c) => serializeCard(c, nm.get(c) || cardNoOf(this.cards, this.cards.indexOf(c)))); })().join("\n\n");
			const wantMeta = this.meta.dirty || hasMetaInFile(raw);
			const metaBlock = wantMeta ? serializeMeta(this.meta) + "\n\n" : "";
			const out =
				sp.head + START_MARK + "\n\n" + metaBlock + body + (body ? "\n\n" : "") + END_MARK + sp.tail;
			await this.app.vault.modify(f, out);
			this._syncedMtime = f.stat && f.stat.mtime ? f.stat.mtime : Date.now();
			this._pendingLoss = false; /* ：写回成功，冲突解除 */
		} catch (e) {
			new Notice("写回案板失败：" + e.message);
		} finally {
			const self = this;
			window.setTimeout(function () {
				self._writing = false;
			}, 400);
		}
		return true;
	}

	/* ---------------- 渲染 ---------------- */

	/* （用户要求·单向滚动守卫）：任何操作（保存索引卡、建卡、删卡、编辑落卡等）
	   之后，页面只允许因为内容变长/变多而向下扩展，**禁止向上位移**。
	   做法：快照当前各滚动容器的位置，稍后分三次回查——凡是比快照更靠上的一律
	   拉回快照位置；向下（内容增长自然带出来的）不拦。 */
	holdViewport() {
		const st =
			typeof window !== "undefined" && typeof window.setTimeout === "function"
				? window.setTimeout.bind(window)
				: setTimeout;
		const snap = [];
		const board = this.root && this.root.querySelector ? this.root.querySelector(".stc-board") : null;
		if (board) snap.push([board, board.scrollTop]);
		const anc =
			this.root && this.root.closest
				? this.root.closest(".markdown-preview-view, .cm-scroller, .view-content")
				: null;
		if (anc && anc !== board) snap.push([anc, anc.scrollTop]);
		const winY = (typeof window !== "undefined" && window.scrollY) || 0;
		const token = (this._guardToken = (this._guardToken || 0) + 1);
		const reassert = () => {
			if (this._guardToken !== token) return; /* 已被更新的操作取代 */
			for (const pair of snap) {
				const el = pair[0];
				const top = pair[1];
				if (el && el.scrollTop < top) el.scrollTop = top;
			}
			if (winY && (typeof window !== "undefined" && (window.scrollY || 0)) < winY) window.scrollTo(0, winY);
		};
		st(reassert, 0);
		st(reassert, 150);
		st(reassert, 450);
	}

	/* ：只原地重绘一张卡（索引卡弹窗保存用）——和内联编辑的
	   refreshThisCardOnly 同款思路：把卡面 DOM 换成新渲染的节点，
	   整页不重建，幕布滚动位置完全不动（不许向上位移，只随内容向下延伸）。 */
	refreshCardInPlace(card, actKey, colNo) {
		const idx = this.cards.indexOf(card);
		if (idx < 0) {
			this.render();
			return;
		}
		let el = null;
		try {
			el = this.root.querySelector('.stc-card[data-idx="' + idx + '"]');
		} catch (e) {
			el = null;
		}
		if (!el) {
			this.render();
			return;
		}
		const tmp = document.createElement("div");
		try {
			this.renderCard(tmp, card, idx, actKey, colNo);
		} catch (e) {
			this.render();
			return;
		}
		const fresh = tmp.children && tmp.children[0];
		if (!fresh) {
			this.render();
			return;
		}
		if (el.replaceWith) {
			el.replaceWith(fresh);
			this.holdViewport();
		} else {
			this.render();
		}
	}

	render() {
		/* ：全量重绘前后保存/恢复滚动位置——格式刷、批量选卡、点选等任何
		   触发重绘的操作都不再把页面拽回最顶上。 */
		const prevBox = this.root && this.root.querySelector ? this.root.querySelector(".stc-board") : null;
		const saved = prevBox ? prevBox.scrollTop : 0;
		/* （用户报）：批量点选/新建卡后画面跳回第一列——每幕的横向滚动
		   容器重绘后 scrollLeft 从没保存过。现在逐幕记录并恢复水平位置。 */
		const savedLefts = {};
		/* （用户报）：「整个页面」的滚动也要按住（单向联动）——阅读模式/
		   实时预览下正文容器就是最外层滚动条，卡片操作不许移动它 */
		const winY = (typeof window !== "undefined" && window.scrollY) || 0;
		const ancBox = prevBox && prevBox.closest ? prevBox.closest(".markdown-preview-view, .cm-scroller, .view-content") : null;
		const ancTop = ancBox ? ancBox.scrollTop : 0;
		if (prevBox) {
			prevBox.querySelectorAll(".stc-cards").forEach((c) => {
				if (c.dataset && c.dataset.act && c.scrollLeft) savedLefts[c.dataset.act] = c.scrollLeft;
			});
		}
		this._renderCore();
		const box = this.root && this.root.querySelector ? this.root.querySelector(".stc-board") : null;
		if (box && saved) box.scrollTop = saved;
		if (prevBox) {
			this.root.querySelectorAll(".stc-cards").forEach((c) => {
				const v = c.dataset && savedLefts[c.dataset.act];
				if (v) c.scrollLeft = v;
			});
		}
		if (ancBox) {
			const nb = this.root.closest ? this.root.closest(".markdown-preview-view, .cm-scroller, .view-content") : null;
			if (nb && nb.scrollTop !== ancTop) nb.scrollTop = ancTop;
		}
		if (winY) {
			const y = window.scrollY || 0;
			if (y !== winY) window.scrollTo(0, winY);
		}
		/* ：重绘后让有内容的文本域（幕头备注等）自动撑到合适高度，
		   免得删卡等全量重绘后文本域被压回默认 2 行高度 */
		try {
			const root = this.root;
			if (root && root.querySelectorAll) {
				root.querySelectorAll("textarea.stc-actnote, textarea.stc-inline-edit").forEach((ta) => {
					if (ta.value && ta.scrollHeight) {
						ta.style.height = "auto";
						ta.style.height = ta.scrollHeight + "px";
					}
				});
			}
		} catch (e) {
			/* 忽略 */
		}
		/* ：单向滚动守卫（见 holdViewport） */
		this.holdViewport();
	}

	_renderCore() {
		const root = this.root;
		/* 插入线挂在 body 上，重渲染时手动清掉，别留孤儿 */
		if (this._insLine) {
			try {
				if (this._insLine.remove) this._insLine.remove();
			} catch (e) {
				/* ignore */
			}
			this._insLine = null;
		}
		root.empty();
		root.addClass("stc-root");
		root.addClass(this.inline ? "stc-embed" : "stc-panel");
		/* ：root 是复用容器，先摘类再按需加——否则格式刷关掉后 stc-brush-on
		   一直挂在 root 上，十字光标永远变不回来（用户实测的卡死 bug） */
		root.removeClass("stc-brush-on");
		if (this.plugin.brush && this.plugin.brush.on) root.addClass("stc-brush-on");
		/* ：编号按板面视觉顺序（幕→列→从上到下）统一计算 */
		this._noMap = buildNoMap(this.cards, this.meta);
		const f = this.file();

		if (!f) {
			const box = root.createDiv({ cls: "stc-empty" });
			box.createEl("h3", { text: this.inline ? "这个文件不是案板" : "还没有案板" });
			box.createEl("p", {
				text: this.inline
					? "```xw-card-board 代码块要放在案板文件自己里。请用插件的新建案板功能，或在案板文件顶部加一个空的 ```xw-card-board 代码块。"
					: "案板是一块软木板：分成几幕，每幕钉若干张索引卡，行末就是转折点。一张卡 = 一个场景。",
			});
			if (!this.inline) {
				const b1 = box.createEl("button", { text: "新建案板", cls: "mod-cta" });
				b1.addEventListener("click", () => this.plugin.createNewBoard());
				const b2 = box.createEl("button", { text: "选择已有案板文件" });
				b2.addEventListener("click", () => new BoardFileModal(this.app, this.plugin).open());
			}
			return;
		}

		const stats = computeStats(this.cards, this.meta);

		/* 工具条 */
		const bar = root.createDiv({ cls: "stc-toolbar" });
		const fname = bar.createEl("span", { cls: "stc-file", text: f.name });
		fname.setAttr("title", f.path + "（点这里切换案板文件）");
		if (!this.inline) fname.addEventListener("click", () => new BoardFileModal(this.app, this.plugin).open());
		/* 格式刷：把一张卡的宽高刷到别的卡上 */
		const brush = this.plugin.brush || {};
		const bBrush = bar.createEl("button", { cls: "stc-brushbtn" + (brush.on ? " is-active" : "") });
		bBrush.innerHTML = BRUSH_SVG;
		bBrush.setAttr("aria-label", "格式刷");
		bBrush.setAttr(
			"title",
			"格式刷：点它开/关 → 开着时点一张卡记住尺寸 → 点别的卡（或拖框框选）刷上去"
		);
		/* ：还原一键开关（的弹菜单选模式体验不好，砍掉）。
		   幕布防位移保留：开关只原地更新按钮态和基准卡高亮，不整版重绘。 */
		bBrush.addEventListener("click", () => {
			const b = this.plugin.brush || (this.plugin.brush = { on: false, active: false, w: 0, h: 0, src: null });
			const prevSrc = b.src;
			b.on = !b.on;
			b.active = false;
			b.w = 0;
			b.h = 0;
			b.src = null;
			if (b.on) bBrush.addClass("is-active");
			else bBrush.removeClass("is-active");
			this.refreshCardSizesInPlace(prevSrc ? [prevSrc] : []);
			new Notice(b.on ? "格式刷已打开：先点一张卡作为尺寸基准。" : "格式刷已关闭。");
		});

		/* ：宽/高锁定——开着时拖拽把手不能改这一维（只能拖另一维）。
		   只限拖拽；格式刷照旧刷两维；弹窗手填不受限。状态会话内记住。 */
		if (!this.plugin.locks) this.plugin.locks = { w: false, h: false };
		const mkLockBtn = (dim, label, tip) => {
			const btn = bar.createEl("button", {
				cls: "stc-lockbtn" + (this.plugin.locks[dim] ? " is-active" : ""),
				text: label,
			});
			btn.setAttr("aria-label", tip);
			btn.setAttr("title", tip);
			btn.addEventListener("click", () => {
				this.plugin.locks[dim] = !this.plugin.locks[dim];
				if (this.plugin.locks[dim]) btn.addClass("is-active");
				else btn.removeClass("is-active");
				new Notice(
					this.plugin.locks[dim]
						? label + "已开启：卡片" + (dim === "w" ? "宽度" : "高度") + "锁定，拖拽只能改" + (dim === "w" ? "高" : "宽") + "。"
						: label + "已关闭。"
				);
			});
		};
		mkLockBtn("w", "锁宽", "宽度锁定：开着时拖拽把手只能改卡片高度，宽度不变。");
		mkLockBtn("h", "锁高", "高度锁定：开着时拖拽把手只能改卡片宽度，高度不变。");

		/* 批量选择（； 简化为单态）：格式刷右侧。点＝进入/退出多选；
		   多选时点卡片选中/取消；**拖任意一张选中的卡，整组跟着走**（和单卡拖拽一样有插入线）。 */
		const bBatch = bar.createEl("button", { cls: "stc-batchbtn" + (this.batch ? " is-active" : "") });
		bBatch.innerHTML = BATCH_SVG;
		bBatch.setAttr("aria-label", "批量移动");
		bBatch.setAttr(
			"title",
			this.batch
				? "批量：已选 " + this.batch.picked.size + " 张。拖任意选中的卡＝整组移动；再点本按钮退出。"
				: "批量移动：点它 → 点几张卡选中 → 拖任意选中的卡，整组跟着走"
		);
		bBatch.addEventListener("click", () => {
			/* （用户报）：进/出批量模式不再整版重绘（幕布会被拽上去）——
			   原地改每张卡的可拖性/高亮和按钮态。 */
			if (!this.batch) {
				this.batch = { picked: new Set() };
				this.setBatchCardsDom(true);
				bBatch.addClass("is-active");
				bBatch.setAttr("title", "批量：已选 0 张。拖任意选中的卡＝整组移动；再点本按钮退出。");
				new Notice("批量：点卡片选中 / 取消（可多选）。拖任意选中的卡，整组跟着走；再点本按钮退出。");
			} else {
				this.batch = null;
				this.setBatchCardsDom(false);
				bBatch.removeClass("is-active");
				bBatch.setAttr("title", "批量移动：点它 → 点几张卡选中 → 拖任意选中的卡，整组跟着走");
				new Notice("已退出批量模式。");
			}
		});

		/* 汇总：把写了「事」的卡按编号合成正文，知乎风（编号去零、导语排最前） */
		const bSummary = bar.createEl("button", { text: "汇总" });
		bSummary.setAttr("title", "把所有写了「事」的卡按编号汇成一份正文（导语卡自动排最前、编号 0），可一键复制。");
		bSummary.addEventListener("click", () => new SummaryModal(this.app, summarizeCards(this.cards, this.meta, this._noMap)).open());

		const bCheck = bar.createEl("button", { text: "自检" });
		bCheck.addEventListener("click", () => this.plugin.selfCheck(this.cards, this.meta));
		const bAnchor = bar.createEl("button", { text: "插入 15 张空白节拍卡" });
		bAnchor.addEventListener("click", () => this.insertAnchors());
		/* （用户要求）：导入模板——从任一已有案板复制幕布＋卡片布局（不含内容） */
		const bTpl = bar.createEl("button", { text: "导入模板" });
		bTpl.setAttr(
			"title",
			"选一个已有案板当模板：复制它的幕布布局＋卡片布局（幕/列/宽/高/节拍），卡片内容不导入。当前板面有卡时会要求二次确认。"
		);
		bTpl.addEventListener("click", () => {
			new BoardFileModal(this.app, this.plugin, {
				pickTitle: "选择要当模板的案板文件……",
				onPick: (f) => this.importTemplateLayout(f),
			}).open();
		});
		if (!this.inline) {
			const bNew = bar.createEl("button", { text: "新建案板" });
			bNew.addEventListener("click", () => this.plugin.createNewBoard());
		}
		const bReload = bar.createEl("button", { text: "重新读取" });
		bReload.addEventListener("click", () => {
			/* （用户报）：有修改被防丢卡保护拦下时，重新读取=放弃这些修改，需二次确认 */
			if (this._pendingLoss && !this._reloadConfirmed) {
				new Notice("有修改还没写入文件（被别处的改动抢先了）。再点一次「重新读取」= 放弃这些修改并载入文件内容（以文件为准）。");
				this._reloadConfirmed = true;
				return;
			}
			this._pendingLoss = false;
			this._reloadConfirmed = false;
			this.reload();
		});
		/* （用户要求）：手动保存按钮——平时改动都自动保存；怀疑没存上时点这个 */
		const bSaveManual = bar.createEl("button", { text: "保存" });
		bSaveManual.setAttr("title", "把当前板面手动写回案板文件（有防丢卡保护：文件被别处改过时会拒绝写入并提示）");
		bSaveManual.addEventListener("click", async () => {
			/* （用户要求）：冲突时可选择谁覆盖谁——保存×2＝以我为准覆盖文件；重新读取×2＝以文件为准 */
			if (this._pendingLoss && !this._saveConfirmed) {
				new Notice("文件被别处改过。再点一次「保存」＝ 用当前板面覆盖文件（以我为准）；想以文件为准就点「重新读取」两次。");
				this._saveConfirmed = true;
				return;
			}
			this._saveConfirmed = false;
			const okW = await this.persist(this._pendingLoss === true);
			new Notice(okW === false ? "没有写入：案板文件刚被别处修改过。再点一次「保存」＝以我为准覆盖。（防丢卡保护）" : "已把当前板面内容写回案板文件。");
		});
		/* ：删掉「收起下面的原始清单」按钮（用户指定）——旧实现从未生效过，
		   重写两版在真实文件里也收不全（原始清单是插件管理的数据本体，本就建议不手改），
	   没有存在价值了。 */

		/* 统计条：只报卡数与合规，不报字数。
		   （用户要求）：卡数检查已移除——这里只报「共 N 张卡」，不再有 共 N/目标 的形式。 */
		const st = root.createDiv({ cls: "stc-stats" });
		st.createEl("span", { text: "共 " + stats.total + " 张卡" });
		/* （用户报）：「标出不完整的卡」关掉时，合规统计（合规 X/Y、缺 ＋/－、
		   缺 ＞＜）一并隐藏——卡上的圆点都不报色了，顶上的红字没必要留。卡数照常显示。 */
		if (this.plugin.settings.markBad) {
			const bad = this.cards.filter((c) => checkCard(c).length).length;
			st.createEl("span", {
				text: "合规：" + (this.cards.length - bad) + " / " + this.cards.length,
				cls: bad ? "stc-bad" : "stc-ok",
			});
			st.createEl("span", { text: "缺 ＋/－：" + stats.missingPM, cls: stats.missingPM ? "stc-bad" : "stc-ok" });
			st.createEl("span", { text: "缺 ＞＜：" + stats.missingCF, cls: stats.missingCF ? "stc-bad" : "stc-ok" });
		}

		/* 各幕 */
		const board = root.createDiv({ cls: "stc-board" });
		for (const a of stats.acts) {
			this.renderRow(board, a);
		}
		if (stats.tray.length) {
			this.renderTray(board, stats.tray);
		}
		/* ：格式刷开启时支持按住拖出虚线框，框内的卡批量刷尺寸 */
		this.bindMarquee(board);

		/* 加一幕 */
		const addRow = board.createDiv({ cls: "stc-addact" });
		const bAddAct = addRow.createEl("button", { text: "＋ 加一幕" });
		bAddAct.addEventListener("click", () => {
			new AddActModal(this.app, async (v, participate) => {
				if (!v) return;
				this.meta.addAct(v, participate);
				await this.persist();
				this.render();
			}).open();
		});
		if (this.inline) this.fixEmbedSticky(); /* ：解除内嵌容器的 overflow 裁剪 */
	}

	/* （用户报）：内嵌模式下工具条 sticky 被中间层 overflow 裁剪困住，
	   Obsidian/主题在代码块外层套的容器各不相同，CSS 猜类名猜不全。
	   渲染后从根节点向上走：找到第一个真正可滚动的祖先（笔记视图）为止，
	   把途中所有带 overflow 裁剪的中间层就地改成 visible——
	   sticky 必然对准笔记滚动容器生效，不依赖具体类名/主题。 */
	fixEmbedSticky() {
		try {
			if (typeof document === "undefined" || !this.root || !this.root.parentElement) return;
			const isScroller = (el) => {
				try {
					const ov = getComputedStyle(el).overflowY;
					return el.scrollHeight > el.clientHeight + 1 && (ov === "auto" || ov === "scroll");
				} catch (e) {
					return false;
				}
			};
			const path = [];
			let node = this.root.parentElement;
			let depth = 0;
			while (node && node !== document.body && depth < 30) {
				if (isScroller(node)) break;
				path.push(node);
				node = node.parentElement;
				depth++;
			}
			for (const el of path) {
				let ov = "";
				try {
					ov = getComputedStyle(el).overflowY;
				} catch (e) {
					continue;
				}
				if (ov && ov !== "visible") el.style.setProperty("overflow", "visible", "important");
			}
		} catch (e) {
			/* ignore */
		}
	}

	async reload() {
		await this.load();
		this.render();
	}

	renderRow(board, actStats) {
		const key = actStats.key;
		const row = board.createDiv({ cls: "stc-row" });
		row.dataset.act = key;

		const head = row.createDiv({ cls: "stc-rowhead" });

		/* 幕名（：直接点名字改名，铅笔图标删了）+ 上移 / 下移 / 删（挪到「N 张 / 列」下面） */
		const nameRow = head.createDiv({ cls: "stc-actname-row" });
		const nameEl = nameRow.createEl("div", { cls: "stc-actname", text: actStats.label });
		const renameAct = () => {
			const idx = this.meta.indexOf(key);
			new TextPromptModal(this.app, {
				title: "改幕名",
				desc: "只改显示的名字，卡片不会动。",
				value: key,
				onSubmit: async (v) => {
					if (!v || v === key) return;
					/* ：幕名是卡片「幕」字段的关联键，两幕不能真的重名——
					   改成已存在的名字时改为两幕互换名字（卡片的「幕」字段同时对调）。
					   比如「第二幕」移到第三位后改成「第三幕」，原第三幕自动变回「第二幕」。 */
					const otherIdx = this.meta.keys().indexOf(v);
					if (otherIdx > -1 && otherIdx !== idx) {
						this.meta.swapNames(idx, otherIdx);
						for (const c of this.cards) {
							const a = normAct(c.get(K.act), [key, v]);
							if (a === key) c.set(K.act, v);
							else if (a === v) c.set(K.act, key);
						}
						await this.persist();
						this.render();
						return;
					}
					if (!this.meta.rename(idx, v)) {
						new Notice("改名失败：名字不能为空。");
						return;
					}
					/* 卡片上的「幕」字段跟着改，不然卡会掉到收卡盘 */
					for (const c of this.cards) {
						if (normAct(c.get(K.act), [key]) === key) c.set(K.act, v);
					}
					await this.persist();
					this.render();
				},
			}).open();
		};
		nameEl.setAttr("title", "点一下改这一幕的名字");
		nameEl.addEventListener("click", renameAct);

		/* （用户要求）：✕ ↑ ↓ ˄ 这一排挪到幕名正下方（与「N 张/列/移动」行交换），
		   常显不隐藏、靠左对齐；参与汇总开关从幕名旁挪到这一排 ˄ 右边，
		   样式改为圆角方块——实心=参与汇总、空心=不参与。 */
		const tools2 = head.createDiv({ cls: "stc-act-tools stc-act-tools-row" });
		const mkTool = (text, title, fn) => {
			const b = tools2.createEl("button", { cls: "stc-mini-btn", text: text });
			b.setAttr("title", title);
			b.addEventListener("click", fn);
			return b;
		};
		mkTool("✕", "删掉这一幕（这幕里不能有卡）", async () => {
			const idx = this.meta.indexOf(key);
			if (actStats.count > 0) {
				new Notice("这一幕里还有 " + actStats.count + " 张卡，先把它们拖到别的幕（或删掉）再删幕。");
				return;
			}
			if (!this.meta.removeAct(idx)) {
				new Notice("至少要留一幕。");
				return;
			}
			await this.persist();
			this.render();
		});
		mkTool("↑", "把这一幕上移", async () => {
			if (this.meta.moveAct(this.meta.indexOf(key), -1)) {
				this.sortCardsByActs(); /* ：幕动了，卡序跟着重排，编号即时刷新 */
				await this.persist();
				this.render();
			}
		});
		mkTool("↓", "把这一幕下移", async () => {
			if (this.meta.moveAct(this.meta.indexOf(key), 1)) {
				this.sortCardsByActs();
				await this.persist();
				this.render();
			}
		});
		/* ：˄ 折叠本幕 / ˅ 展开——状态随文件持久化（stc:collapsed 行）。
		   ：折叠态整排收进幕名一行（只留标题行），由 CSS 类 stc-row-collapsed 控制。
		   原地切换，不整版重绘（防幕布位移）。 */
		const colBtn = tools2.createEl("button", { cls: "stc-mini-btn stc-collapse-btn" });
		const paintCollapse = () => {
			const a = this.meta.acts[this.meta.indexOf(key)];
			const c = !!(a && a.collapsed);
			colBtn.setText(c ? "˅" : "˄");
			colBtn.setAttr("title", c ? "展开这一幕" : "折叠这一幕（只留标题行）");
		};
		paintCollapse();
		colBtn.addEventListener("click", async () => {
			const a = this.meta.acts[this.meta.indexOf(key)];
			if (!a) return;
			a.collapsed = !a.collapsed;
			this.meta.dirty = true;
			const rowEl = colBtn.closest ? colBtn.closest(".stc-row") : null;
			if (rowEl && rowEl.toggleClass) rowEl.toggleClass("stc-row-collapsed", !!a.collapsed);
			paintCollapse();
			try {
				await this.persist();
			} catch (e) {
				/* 写回失败也不影响本次折叠显示；下次成功保存会带上 */
			}
		});
		/* （用户要求）：参与汇总指示——圆点（样式参考索引卡右上角状态点）：
		   实心（主题强调色）=参与汇总，空心=不参与；点击在两个图标间切换，无勾无滑动条 */
		const sumBtn = tools2.createEl("button", {
			cls: "stc-mini-btn stc-sum-btn " + (actStats.excluded ? "stc-sum-off" : "stc-sum-on"),
		});
		sumBtn.createEl("span", { cls: "stc-sum-dot" });
		const paintSum = () => {
			const a = this.meta.acts[this.meta.indexOf(key)];
			const on = !(a && a.summary === false);
			sumBtn.addClass(on ? "stc-sum-on" : "stc-sum-off");
			sumBtn.removeClass(on ? "stc-sum-off" : "stc-sum-on");
			sumBtn.setAttr("title", on ? "本幕参与汇总（点一下改为不参与）" : "本幕不参与汇总（点一下改回参与）");
		};
		paintSum();
		sumBtn.addEventListener("click", async () => {
			const idx = this.meta.indexOf(key);
			if (idx < 0) return;
			const a = this.meta.acts[idx];
			a.summary = !(a.summary !== false);
			this.meta.summary[idx] = a.summary;
			this.meta.dirty = true;
			paintSum();
			await this.persist();
			/* （用户报）：参与状态变了只原地更新全板序号，不整版重绘（防幕布位移） */
			this.refreshNumbersInPlace();
		});

		/* 卡数 + 列数
		   （用户要求）：黑洞 / 「还可加 N 张」提示随卡数检查一并移除，这里只留「N 张」。 */
		const metaRow = head.createDiv({ cls: "stc-actmeta stc-cols-row" });
		metaRow.createEl("span", { text: actStats.count + " 张" });
		const colSel = metaRow.createEl("select", { cls: "stc-col-select" });
		for (let i = 1; i <= MAX_COLS; i++) {
			const o = colSel.createEl("option", { text: i + " 列" });
			o.value = String(i);
		}
		colSel.value = String(actStats.cols);
		colSel.setAttr("title", "这一幕排成几列。改列数不会把已有的卡挪走 —— 每张卡自己记着在第几列。");
		colSel.addEventListener("change", async () => {
			/* （用户报）：改列数时**幕布不要位移**——先记下本幕行在视口里的位置，
			   重排完成后把垂直滚动补偿回原处（本幕高度变化引起的上下位移全部抵消） */
			let anchorTop = null;
			const findRow = () => {
				const rows = this.root.querySelectorAll(".stc-row");
				for (let i = 0; i < rows.length; i++) {
					if (rows[i].dataset && rows[i].dataset.act === key) return rows[i];
				}
				return null;
			};
			const row0 = findRow();
			if (row0 && row0.getBoundingClientRect) anchorTop = row0.getBoundingClientRect().top;
			this.meta.setCols(key, toInt(colSel.value, 1));
			/* （用户要求）：恢复以前的列规则——改列数**完全不碰任何卡的
			   列字段**。超出列数的卡只在显示上夹进最后一列（列字段保留），
			   之后再改回来会原样恢复（与备份版行为一致）。 */
			await this.persist();
			this.render();
		});
		/* 把原先做错放在卡片区的「移动」下拉挪到「列」右侧（去掉「移动」标签）。
		   选另一幕后，本幕整体移到它正下方。功能不变，只改位置与去掉「移动」二字。 */
		const moveSel = metaRow.createEl("select", { cls: "stc-col-select stc-move-sel" });
		const mvPh = moveSel.createEl("option", { text: "移动", value: "" });
		mvPh.disabled = true;
		mvPh.selected = true;
		this.meta.keys().forEach((k) => {
			if (k === key) return; /* 不能移到自己下方 */
			moveSel.createEl("option", { text: k, value: k });
		});
		moveSel.setAttr("title", "选另一幕后，本幕整体移到它正下方。");
		moveSel.addEventListener("change", async () => {
			const target = moveSel.value;
			if (!target) return;
			const from = this.meta.indexOf(key);
			const to = this.meta.indexOf(target);
			if (from < 0 || to < 0) return;
			this.meta.moveActAfter(from, to);
			this.sortCardsByActs(); /* ：幕动了，卡序跟着重排，编号即时刷新 */
			await this.persist();
			this.render();
			/* 视口锚定：把本幕行拉回改动前它在屏幕上的位置 */
			const row1 = findRow();
			if (anchorTop != null && row1 && row1.getBoundingClientRect) {
				const delta = row1.getBoundingClientRect().top - anchorTop;
				if (delta) {
					const boardEl = this.root.querySelector(".stc-board");
					if (boardEl && boardEl.scrollHeight > boardEl.clientHeight) boardEl.scrollTop += delta;
					else window.scrollBy(0, delta);
				}
			}
		});
		/* 幕头备注：＋ 加文本域、－ 删聚焦条（有字的要再点一次确认），无弹窗直接编辑。
		   ：－ 挪到 ＋ 旁边（不再贴在每条文本域上），＋－ 并排有间距；
		   文本域透明背景+细线框，不再顶开左栏宽度。 */
		const actIdx = this.meta.indexOf(key);
		const notes = this.meta.acts[actIdx] && (this.meta.acts[actIdx].notes = this.meta.acts[actIdx].notes || []);
		let lastFocused = null; /* － 删除目标：最后聚焦的那条；没聚焦过就删最后一条 */
		const notesBox = head.createDiv({ cls: "stc-actnotes" });
		/* （用户要求）：备注行拖动排序——左上角把手（与卡片右下角缩放把手对称），
		   拖到另一条备注上：中腹=互换、靠边=插到前/后（与卡片拖拽同款语义） */
		let noteDragRow = null;
		const clearNoteMarks = () => {
			notesBox.querySelectorAll(".stc-actnote-row").forEach((r) => {
				r.removeClass("stc-drop-swap");
				r.removeClass("stc-drop-before");
				r.removeClass("stc-drop-after");
			});
		};
		const addNoteRow = (value) => {
			const nrow = notesBox.createDiv({ cls: "stc-actnote-row" });
			/* （用户要求）：右上角隐形热区——没有任何可见标记，鼠标悬停到
			   框的右上角时光标变 grab 小手，按住即可拖到另一条备注上：
			   中腹=互换、靠边=插到前/后 */
			const ngrip = nrow.createDiv({ cls: "stc-note-grip" });
			ngrip.setAttr("title", "拖动排序：中腹=互换，靠边=插到前/后");
			ngrip.draggable = true;
			ngrip.addEventListener("click", (e) => e.stopPropagation());
			ngrip.addEventListener("mousedown", (e) => e.stopPropagation());
			ngrip.addEventListener("dragstart", (e) => {
				noteDragRow = nrow;
				nrow.addClass("stc-note-dragging");
				try {
					e.dataTransfer.setData("text/plain", "stc-note");
					e.dataTransfer.effectAllowed = "move";
				} catch (err) {
					/* ignore */
				}
			});
			ngrip.addEventListener("dragend", () => {
				noteDragRow = null;
				nrow.removeClass("stc-note-dragging");
				clearNoteMarks();
			});
			const ta = nrow.createEl("textarea", { cls: "stc-actnote" });
			ta.value = String(value || "");
			ta.rows = 2;
			/* ：占位文字「这一幕想记点什么…」删掉（用户指定） */
			ta.addEventListener("focus", () => {
				lastFocused = nrow;
			});
			ta.addEventListener("change", async () => {
				/* 按行的位置写回 notes（行序 == notes 序；删除走重绘，不会错位） */
				const rowIdx = Array.prototype.indexOf.call(notesBox.children, nrow);
				if (rowIdx > -1) notes[rowIdx] = ta.value;
				this.meta.dirty = true;
				await this.persist();
			});
			nrow.addEventListener("dragover", (e) => {
				if (!noteDragRow || noteDragRow === nrow) return;
				e.preventDefault();
				e.stopPropagation();
				const mode = dropMode(nrow, e);
				clearNoteMarks();
				nrow.addClass(
					mode === "swap" ? "stc-drop-swap" : mode === "before" ? "stc-drop-before" : "stc-drop-after"
				);
			});
			nrow.addEventListener("drop", async (e) => {
				if (!noteDragRow || noteDragRow === nrow) return;
				e.preventDefault();
				e.stopPropagation();
				const src = noteDragRow;
				noteDragRow = null;
				src.removeClass("stc-note-dragging");
				const mode = dropMode(nrow, e);
				const srcTa = src.querySelector("textarea.stc-actnote");
				const dstTa = nrow.querySelector("textarea.stc-actnote");
				if (mode === "swap") {
					const tmp = srcTa.value;
					srcTa.value = dstTa.value;
					dstTa.value = tmp;
				} else {
					/* 插入：把来源行挪到目标行前/后（DOM 移动，notes 随后按行序重建） */
					nrow.parentNode.insertBefore(src, mode === "after" ? nrow.nextSibling : nrow);
				}
				clearNoteMarks();
				/* 行序 == notes 序：拖完按 DOM 行序重建 notes（与 change 回写约定一致） */
				const tas = notesBox.querySelectorAll("textarea.stc-actnote");
				notes.length = 0;
				for (let i = 0; i < tas.length; i++) notes.push(tas[i].value);
				this.meta.dirty = true;
				await this.persist();
				this.render();
			});
		};
		notes.forEach((v) => addNoteRow(v));

		const noteBar = head.createDiv({ cls: "stc-act-tools stc-actnote-add" });
		const mkNoteBtn = (text, title, fn) => {
			const b = noteBar.createEl("button", { cls: "stc-mini-btn", text: text });
			b.setAttr("title", title);
			b.addEventListener("click", fn);
			return b;
		};
		mkNoteBtn("＋", "加一个备注文本域", () => {
			notes.push("");
			this.meta.dirty = true;
			addNoteRow("");
			notesBox.lastChild.querySelector(".stc-actnote").focus();
		});
		const delBtn = mkNoteBtn("－", "删掉聚焦中的备注（有内容时需再点一次确认）", async () => {
			const target = lastFocused && notesBox.contains(lastFocused) ? lastFocused : notesBox.lastChild;
			if (!target) {
				new Notice("还没有备注可删。");
				return;
			}
			const ta = target.querySelector(".stc-actnote");
			if (ta.value.trim() && delBtn.textContent === "－") {
				/* 有字：第一次点变成确认键，再点才删（无弹窗） */
				delBtn.textContent = "确认删?";
				delBtn.addClass("stc-actnote-del-arm");
				return;
			}
			const i = notes.indexOf(ta.value);
			if (i > -1) notes.splice(i, 1);
			this.meta.dirty = true;
			await this.persist();
			this.render();
		});

		/* （用户指定）：行末的「行末应为 XX」铰链提示删了——节拍在卡片下拉里直接选就行。
		   铰链数据本身保留，自检仍按它校验行末节拍对位。 */

		const area = row.createDiv({ cls: "stc-cards" });
		area.dataset.act = key;
		area.dataset.cols = String(actStats.cols);
		/* ：折叠的幕整排收进幕名一行（只留标题行），由 CSS 类 stc-row-collapsed 控制 */
		const actNow = this.meta.acts[this.meta.indexOf(key)];
		if (actNow && actNow.collapsed && row.addClass) row.addClass("stc-row-collapsed");
		const list = this.cards
			.map((c, i) => ({ c: c, i: i }))
			.filter((x) => x.c.act(this.keys()) === key);

		/* 每张卡落在自己「列」字段指定的那一列（没写 = 第 1 列）。
		   这里**不是**按顺序轮流分列 —— 那样一加列，原来全在第 1 列的卡就被挪走了。
		   每列仍是一条独立的竖排栈，所以列与列之间行高也不会互相传染。 */
		const buckets = this.buildColumns(area, actStats.cols);
		list.forEach((x) => {
			const ci = Math.min(x.c.col(actStats.cols), buckets.length) - 1;
			this.renderCard(buckets[ci], x.c, x.i, key, ci + 1);
		});

		/* 每列末尾一个小「＋」：想加在哪一列，就点哪一列 */
		buckets.forEach((colEl, ci) => {
			const plus = colEl.createDiv({ cls: "stc-slot stc-slot-mini" });
			plus.dataset.act = key;
			plus.dataset.col = String(ci + 1);
			plus.setText("＋");
			plus.setAttr("title", "在第 " + (ci + 1) + " 列末尾加一张卡");
			plus.addEventListener("click", () => this.addCard(key, ci + 1));
		});
		this.bindRowDrop(area, key);
	}

	renderTray(board, trayCards) {
		const row = board.createDiv({ cls: "stc-row stc-tray" });
		const head = row.createDiv({ cls: "stc-rowhead" });
		head.createEl("div", { cls: "stc-actname", text: "收卡盘（待定）" });
		head.createEl("div", { cls: "stc-actmeta", text: "还没归行的卡，先钉这儿" });
		const area = row.createDiv({ cls: "stc-cards" });
		area.dataset.act = "待定";
		area.dataset.cols = "3";
		const list = this.cards
			.map((c, i) => ({ c: c, i: i }))
			.filter((x) => x.c.act(this.keys()) === "待定");
		const buckets = this.buildColumns(area, 3);
		list.forEach((x) => {
			const ci = Math.min(x.c.col(3), buckets.length) - 1;
			this.renderCard(buckets[ci], x.c, x.i, "待定", ci + 1);
		});
		buckets.forEach((colEl, ci) => {
			const plus = colEl.createDiv({ cls: "stc-slot stc-slot-mini" });
			plus.dataset.act = "待定";
			plus.dataset.col = String(ci + 1);
			plus.setText("＋");
			plus.setAttr("title", "在第 " + (ci + 1) + " 列末尾扔一张卡");
			plus.addEventListener("click", () => this.addCard("待定", ci + 1));
		});
		this.bindRowDrop(area, "待定");
	}

	/* 把一行分成 n 条**互相独立**的竖排栈。
	   为什么不用 grid：grid 的「行高」是全网格共享的，第 1 行里某张卡拉高，
	   第 2 行（也就是隔壁列的下一张）会被一起往下推。用独立的 flex 竖排，
	   同列拉高只推同列下面的卡，隔壁列完全不动。 */
	buildColumns(area, n) {
		const wrap = area.createDiv({ cls: "stc-cols" });
		const buckets = [];
		const count = Math.max(1, toInt(n, 1));
		for (let i = 0; i < count; i++) {
			const el = wrap.createDiv({ cls: "stc-col" });
			el.dataset.col = String(i + 1);
			el.setAttr("title", "第 " + (i + 1) + " 列：可以把卡拖到这一列的空处，或者点底下的「＋」加一张");
			buckets.push(el);
		}
		return buckets;
	}

	renderCard(area, card, idx, actKey, colNo) {
		const el = area.createDiv({ cls: "stc-card" });
		const batch = this.batch || null;
		/* ：批量模式下，选中的卡仍然可拖（拖一张＝整组走）；未选中的卡不可拖（点了是选卡）。
		   ：格式刷开着时也禁卡片拖拽——按住拖是画框批量刷。
		    修正： 的表达式把批量选中卡的可拖性一并干掉了（「拖动无反应」的根因）。
		   现在拆开判断：格式刷开着禁拖；批量选中的卡必须可拖。 */
		const brushOn = !!(this.plugin.brush && this.plugin.brush.on);
		const pickedNow = !!(batch && batch.picked && batch.picked.has(card));
		el.draggable = pickedNow || (!batch && !brushOn);
		el.dataset.idx = String(idx);
		const accent = card.resolveColor(this.plugin.colorMapObj());
		if (accent) el.style.setProperty("--stc-accent", accent);
		/* 手动尺寸：写死，不跟文字走 */
		el.style.width = card.width() + "px";
		el.style.height = card.height() + "px";

		const top = el.createDiv({ cls: "stc-card-top" });
		/* ：不参与汇总的幕，卡面不显示序号（编号只发给参与汇总的卡） */
		const shownNo = this._noMap ? this._noMap.get(card) : cardNoOf(this.cards, idx);
		if (shownNo) top.createEl("span", { cls: "stc-num", text: shownNo });
		const beat = card.beat();
		if (beat) top.createEl("span", { cls: "stc-beat", text: beat });
		if (isTerminator(beat)) top.createEl("span", { cls: "stc-turn", text: "转折点" });
		if (isParagraphCard(card)) top.createEl("span", { cls: "stc-para", text: "段落卡" });

		const colorLabel = String(card.get(K.color)).trim();
		const meta = top.createDiv({ cls: "stc-meta" });
		if (colorLabel) {
			/* （用户指定）：色块删了，只留名字（左边色条还在，颜色不丢） */
			meta.createEl("span", { cls: "stc-chip", text: colorLabel });
		}

		const body = el.createDiv({ cls: "stc-body" });
		const scene = card.get(K.scene);
		if (scene) body.createEl("div", { cls: "stc-scene", text: scene });
		const actionRaw = String(card.get(K.action));
		const action = actionRaw.trim();
		/* （用户指定）：「事」可以直接点击原地改写（像写正文一样），不弹窗；
		   其余字段仍走索引卡弹窗。空「事」时显示节拍释义占位，点它编辑的是「事」本身。
		   ：原始值非空（哪怕只是空格占位）就按正常「事」行渲染——占位行可见可点。
		   （用户报）：新建卡的「事」是空格占位，旧逻辑空格也算「有内容」，
		   选了节拍后占位符永远不换。现在「事」没写真内容（空/纯空格）时，
		   占位行显示当前节拍的释义（跟节拍走）；没选节拍时维持原空格占位行，照样可见可点。 */
		const beatHint = beatDesc(beat);
		/* desc 样式：事为空串，或事只有空格但已选带释义的节拍（这两种都是"占位"态） */
		const isDescPlaceholder = !action && (!actionRaw || !!beatHint);
		const showAction = action ? actionRaw : beatHint || actionRaw;
		const actionEl = body.createDiv({
			cls: "stc-action" + (isDescPlaceholder ? " stc-action-desc" : ""),
			text: showAction,
		});
		if (!showAction) {
			actionEl.addClass("stc-hide");
		}
		/* ：批量多选时卡片高亮 */
		if (batch && batch.picked && batch.picked.has(card)) el.addClass("stc-picked");
		if (batch) el.addClass("stc-batch-pick");
		actionEl.addClass("stc-action-editable");
		actionEl.setAttr(
			"title",
			batch ? "点这里选中 / 取消这张卡" : "点一下直接改写「事」（Esc 取消）"
		);
		/* ：鼠标移到「事」文本域上时，关掉整卡拖拽——抓取手不再生效、
		   也不会和输入框抢鼠标（点进去能正常落光标、选字、输入）。移开再恢复。 */
		const cardDraggableWhenIdle = el.draggable;
		actionEl.addEventListener("mouseenter", () => {
			if (!this.batch) el.draggable = false;
		});
		actionEl.addEventListener("mouseleave", () => {
			if (!this.batch && !actionEl.hasClass("stc-editing")) el.draggable = cardDraggableWhenIdle;
		});
		const startEdit = () => {
			if (this.batch) return;
			if (actionEl.hasClass("stc-editing")) return;
			this._editing = true; /* ：标记正在内联编辑，文件被外部改动时不要重载本引擎（免得打断输入） */
			const cur = String(card.get(K.action));
			const ta = document.createElement("textarea");
			ta.value = cur;
			ta.rows = 2;
			ta.className = "stc-inline-edit"; /* 透明背景+虚线框，样式见 CSS；不带 stc-input 的表单底色 */
			actionEl.addClass("stc-editing");
			actionEl.removeClass("stc-hide"); /* 空白卡：编辑时把隐藏的行显示出来，输入框才可见 */
			actionEl.textContent = "";
			actionEl.appendChild(ta);
			el.draggable = false; /* 编辑期间禁止整卡拖拽，免得选不了字 */
			if (ta.focus) ta.focus({ preventScroll: true }); /* ：聚焦不许把页面上滚 */
			/* 随内容自动长高：字不动、光标换行，不在框里滚（field-sizing 不支持时走这条兜底） */
			const grow = () => {
				if (!ta.scrollHeight) return;
				ta.style.height = "auto";
				ta.style.height = ta.scrollHeight + "px";
			};
			ta.addEventListener("input", grow);
			let done = false;
			/* （用户报）：编辑保存后**只原地重绘这一张卡**——整页 render 会销毁
			   焦点节点，浏览器的滚动锚会把整个页面拽走。单向联动：卡片操作永不移动幕布。 */
			const refreshThisCardOnly = () => {
				const tmp = document.createElement("div");
				try {
					const curIdx = Math.max(0, this.cards.indexOf(card));
					this.renderCard(tmp, card, curIdx, actKey, colNo);
				} catch (e) {
					this.render();
					return;
				}
				const fresh = tmp.children && tmp.children[0];
				if (!fresh) { this.render(); return; }
				if (el.replaceWith) {
					el.replaceWith(fresh);
					this.holdViewport(); /* ：原地换卡也不许把页面顶上去 */
				} else if (el.parentNode) {
					const ps = el.parentNode.children;
					const at = Array.prototype.indexOf.call(ps, el);
					if (at > -1) {
						ps[at] = fresh;
						fresh.parentNode = el.parentNode;
					}
				} else {
					this.render();
				}
			};
			const finish = async (save) => {
				if (done) return;
				done = true;
				const v = save ? ta.value.trim() : cur;
				this._editing = false; /* ：编辑结束，恢复可被外部改动重载 */
				/* ：编辑期间若别的区改了同一份文件，重载会把用户的输入打掉，
				   所以那时候跳过了重载——这里先把磁盘最新内容读进来（拿到别人的改动），
				   再把我们刚写的「事」落到同一张卡上，绝不让别人的改动被反覆盖。 */
				if (this._externalDirty) {
					this._externalDirty = false;
					const idx = this.cards.indexOf(card);
					const beat = card.get(K.beat);
					const act = card.get(K.act);
					await this.reload();
					const target =
						idx >= 0 && this.cards[idx] && this.cards[idx].get(K.beat) === beat && this.cards[idx].get(K.act) === act
							? this.cards[idx]
							: null;
					if (target) target.set(K.action, v);
					else {
						card.set(K.action, v);
						this.cards.push(card); /* 兜底：找不到原卡就补回去，绝不丢字 */
					}
					this._writing = true;
					try {
						await this.persist();
					} catch (e) {
						/* 保存失败也照常重绘 */
					}
					refreshThisCardOnly();
					return;
				}
				this._writing = true;
				card.set(K.action, v);
				try {
					await this.persist();
				} catch (e) {
					/* 保存失败也照常重绘 */
				}
				refreshThisCardOnly();
			};
			ta.addEventListener("blur", () => finish(true));
			ta.addEventListener("keydown", (ev) => {
				if (ev.key === "Escape") finish(false);
			});
		};
		actionEl.addEventListener("click", (e) => {
			if (this.batch) return; /* ：批量模式下点卡片统一由 el 层处理 */
			if (e && e.stopPropagation) e.stopPropagation();
			startEdit();
		});
		/* （用户报）：空白卡没有文字，点卡面任意处（除圆点）直接开始写「事」 */
		body.addEventListener("click", (e) => {
			if (this.batch) return;
			if (actionRaw || beatDesc(beat)) return; /* 有「事」行（含空格占位）的卡由 actionEl 自己处理 */
			startEdit();
		});

		/* ＋/－ 和 ＞＜ 两行：没填就整行不显示（，用户指定），
		   填了才显示。缺项提示交给右上角圆点，不丢信息。
		   标签固定宽度，两行都有时「缺」字才对得齐。
		   （用户要求）：「备」同款规则——填了就显示，不填不显示；
		   纯「段落」标记不重复显示（卡上已有「段落卡」徽章）。 */
		const p = pmParts(card.get(K.pm));
		const hasPM = card.hasPM();
		const cfText0 = String(card.get(K.conflict)).trim();
		const noteTxt = String(card.get(K.note)).trim();
		const showNote = !!noteTxt && noteTxt !== "段落";
		if (hasPM || cfText0 || showNote) {
			const foot = body.createDiv({ cls: "stc-foot" });
			const mkFootLine = (cls, tag, text, miss) => {
				const line = foot.createEl("div", { cls: cls + (miss ? " miss" : "") });
				line.createEl("span", { cls: "stc-tag", text: tag });
				line.createEl("span", { cls: "stc-val", text: text });
				return line;
			};
			if (hasPM) {
				const pmLine = mkFootLine("stc-pm", "＋/－", p.ok && p.from && p.to ? p.from + " → " + p.to : card.get(K.pm), false);
				if (p.ok && p.from && p.to) pmLine.addClass(p.from === "＋" ? "down" : "up");
				if (p.note) pmLine.setAttr("title", p.note);
			}
			if (cfText0) mkFootLine("stc-cf", "＞ ＜", card.get(K.conflict), false);
			if (showNote) mkFootLine("stc-note", "备", noteTxt, false);
		}

		const problems = checkCard(card);
		const brush = this.plugin.brush || {};
		if (brush.on && brush.src && brush.src === card) el.addClass("stc-brush-src");
		/* 圆点报色（桃红）由设置里的「标出不完整的卡」控制；关掉后它只当编辑入口 */
		const showBad = problems.length && this.plugin.settings.markBad;
		if (showBad) el.addClass("stc-badcard");

		/* 右下角的手动改尺寸把手（批量模式下不绑，点卡片就是选卡） */
		if (!this.batch) this.bindResize(el, card);

		/* 编辑入口只在右上角一个小按钮上（也可以双击卡片）。
		   以前整张卡都能点，一拖动/一拉大小就容易误弹索引卡弹窗（用户报的）。 */
		const open = () => {
			/* （用户报）：弹窗保存以前一律整版重绘，整页 DOM 销毁重建会把幕布
			   向上拽。现在幕/列/尺寸都没动时只原地重绘这一张卡；挪了幕或改了尺寸
			   才整版重绘（那时布局真的变了，守卫兜底）。 */
			const beforeAct = card.act(this.keys());
			const beforeCol = card.col(MAX_COLS);
			const beforeW = card.width();
			const beforeH = card.height();
			const beforeBeat = card.beat();
			new CardModal(
				this.app,
				this.plugin,
				card,
				this.meta,
				async () => {
					await this.persist();
					if (
						card.act(this.keys()) === beforeAct &&
						card.col(MAX_COLS) === beforeCol &&
						card.width() === beforeW &&
						card.height() === beforeH
					) {
						this.refreshCardInPlace(card, actKey, colNo);
						/* （用户报）：改节拍不影响幕/列/尺寸，但「导语」这类特型节拍
						   会改变全板编号（导语不占号、其余卡前移）。原地重绘只重画
						   一张卡，序号表是旧的——节拍变了就补一次全板序号原地刷新
						   （只改序号文字，不整版重绘、不拽幕布）。 */
						if (card.beat() !== beforeBeat) this.refreshNumbersInPlace();
					} else {
						this.render();
					}
				},
				async () => {
					const at = this.cards.indexOf(card);
					if (at >= 0) this.cards.splice(at, 1);
					await this.persist();
					this.render();
				}
			).open();
		};

		/* 右上角一个圆点＝编辑入口（也可以双击卡片）。
		   点就在用户原本看红点的那个位置；没问题时它是低饱和的墨绿色。 */
		const dotTip = showBad
			? "这张卡还差：" + problems.join("；") + "（点这里编辑）"
			: "点这里编辑这张卡";
		const dotBtn = el.createDiv({
			cls: "stc-dotbtn " + (showBad ? "stc-dot-bad" : "stc-dot-ok"),
		});
		dotBtn.draggable = false;
		dotBtn.setAttr("title", dotTip);
		dotBtn.createEl("span", { cls: "stc-dotmark" });
		dotBtn.addEventListener("mousedown", (e) => {
			/* 阻止冒泡＝不会启动整张卡的拖拽；preventDefault＝不会被当成拖动目标 */
			if (e.button !== undefined && e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
		});
		dotBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
		dotBtn.addEventListener("touchstart", (e) => e.stopPropagation());
		dotBtn.addEventListener("dragstart", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		dotBtn.addEventListener("click", (e) => {
			if (this.batch) return; /* ：批量模式下点卡片统一由 el 层处理 */
			e.preventDefault();
			e.stopPropagation();
			open();
		});
		el.addEventListener("dblclick", (e) => {
			if (this.batch) return;
			e.stopPropagation();
			open();
		});
		/* 点卡片本体：平时什么都不做（拖动/拉大小就不会误弹窗）；
		   格式刷打开时，点谁就把记住的宽高刷给谁；
		   批量模式：多选=选中/取消，移动=把选中的卡插到这张后面。 */
		el.addEventListener("click", (e) => {
			if (this.batch) {
				e.preventDefault();
				e.stopPropagation();
				this.batchTap(card);
				return;
			}
			if (this._marqueeJustRan) return; /* 刚拖完框批量刷，忽略随后的单击 */
			if (!this.plugin.brush || !this.plugin.brush.on) return;
			e.preventDefault();
			e.stopPropagation();
			this.applyBrush(card);
		});

		this.bindCardDrag(el, idx, colNo);
		return el;
	}

	/* ---------------- 手动改尺寸（右下角把手） ---------------- */

	bindResize(el, card) {
		const grip = el.createDiv({ cls: "stc-grip" });
		grip.draggable = false;
		grip.setAttr("title", "拖动改大小（宽×高写回卡片）");
		grip.addEventListener("click", (e) => e.stopPropagation());
		grip.addEventListener("mousedown", (e) => e.stopPropagation());
		grip.addEventListener("dragstart", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		grip.addEventListener("pointerdown", (e) => e.stopPropagation());

		const self = this;
		let startX = 0,
			startY = 0,
			w0 = 0,
			h0 = 0,
			w = 0,
			h = 0;

		const onMove = (ev) => {
			const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
			const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
			if (ev.cancelable) ev.preventDefault();
			/* ：宽/高锁定——锁定的那一维保持原值，拖拽只改没锁的一维 */
			const locks = self.plugin.locks || {};
			w = locks.w ? w0 : Math.max(MIN_W, Math.round(w0 + (cx - startX)));
			h = locks.h ? h0 : Math.max(MIN_H, Math.round(h0 + (cy - startY)));
			el.style.width = w + "px";
			el.style.height = h + "px";
		};

		const onUp = async () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			window.removeEventListener("touchmove", onMove);
			window.removeEventListener("touchend", onUp);
			el.removeClass("stc-resizing");
			if (!w || !h) return;
			card.set(K.width, String(w));
			card.set(K.height, String(h));
			await self.persist();
		};

		const onDown = (ev) => {
			if (ev.button !== undefined && ev.button !== 0) return;
			ev.preventDefault();
			ev.stopPropagation();
			const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
			const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
			startX = cx;
			startY = cy;
			w0 = el.offsetWidth;
			h0 = el.offsetHeight;
			w = w0;
			h = h0;
			el.addClass("stc-resizing");
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
			window.addEventListener("touchmove", onMove, { passive: false });
			window.addEventListener("touchend", onUp);
		};

		grip.addEventListener("mousedown", onDown);
		grip.addEventListener("touchstart", onDown, { passive: false });
	}

	/* ---------------- 插入位置的线 ---------------- */

	/* 两张卡之间的那条线：fixed 定位的浮层，**不参与布局**，
	   所以拖的时候不会把卡片挤来挤去（这是之前 grid 踩过的坑）。 */
	insLine() {
		if (this._insLine && this._insLine.parentNode) return this._insLine;
		/* ⚠️ 必须挂在 <body> 上。Obsidian 的视图容器带 contain / transform，
		   那会让 position:fixed 的定位基准变成那个祖先而不是窗口 ——
		   线就会被画到别的地方（用户报过「找不到那条线」）。 */
		const host =
			typeof document !== "undefined" && document.body && document.body.createDiv
				? document.body
				: this.root;
		if (!host || !host.createDiv) return null;
		this._insLine = host.createDiv({ cls: "stc-insline" });
		return this._insLine;
	}

	showInsLine(el, after) {
		const line = this.insLine();
		if (!line) return;
		const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
		if (!r || !r.width) {
			line.style.display = "none";
			return;
		}
		/* .stc-col 的 gap 是 8px，把 3px 的线摆在缝里 */
		line.style.display = "block";
		line.style.left = Math.round(r.left) + "px";
		line.style.width = Math.round(r.width) + "px";
		line.style.top = Math.round(after ? r.bottom + 2 : r.top - 5) + "px";
	}

	hideInsLine() {
		if (this._insLine) this._insLine.style.display = "none";
	}

	/* ---------------- 格式刷 ---------------- */

	/* 第一次点：记住这张卡的宽高；之后点谁，就把宽高刷给谁（只刷尺寸，不动内容）。
	   ：拆出 applyBrushSync（只写字段不落盘），供拖框批量刷复用。 */
	/* ：刷完尺寸只原地改这些卡的宽高样式（和 bindResize 同款做法），
	   绝不整版重绘——整页 DOM 销毁重建会把幕布拽上去。顺带维护基准卡高亮。 */
	refreshCardSizesInPlace(list) {
		let touched = 0;
		for (const card of list || []) {
			if (!card) continue;
			const idx = this.cards.indexOf(card);
			if (idx < 0) continue;
			let el = null;
			try {
				el = this.root.querySelector('.stc-card[data-idx="' + idx + '"]');
			} catch (e) {
				el = null;
			}
			if (!el) continue;
			el.style.width = card.width() + "px";
			el.style.height = card.height() + "px";
			const b = this.plugin.brush || {};
			if (b.on && b.src && b.src === card) el.addClass("stc-brush-src");
			else el.removeClass("stc-brush-src");
			touched++;
		}
		if (touched) this.holdViewport();
		return touched;
	}

	applyBrushSync(card) {
		const b = this.plugin.brush;
		if (!b || !b.on || !b.active || !card) return false;
		card.set(K.width, String(b.w));
		card.set(K.height, String(b.h));
		return true;
	}

	async applyBrush(card) {
		const b = this.plugin.brush;
		if (!b || !b.on || !card) return;
		if (!b.active) {
			b.w = card.width();
			b.h = card.height();
			b.active = true;
			b.src = card;
			new Notice("格式刷：记住了这张卡的尺寸 " + b.w + " × " + b.h + "，接着点别的卡片刷上去。");
			this.refreshCardSizesInPlace([card]);
			return;
		}
		if (this.applyBrushSync(card)) {
			await this.persist();
			this.refreshCardSizesInPlace([card]);
		}
	}

	/* ：格式刷开启时，按住鼠标拖出一个虚线框——框住的卡一起刷尺寸。
	   单击（没怎么移动）仍走原来的单卡点击刷。 */
	bindMarquee(board) {
		const self = this;
		board.addEventListener("mousedown", function (e) {
			const b = self.plugin.brush;
			if (!b || !b.on) return;
			if (e.button !== undefined && e.button !== 0) return;
			e.preventDefault(); /* 框选期间不启动卡片拖拽、不选中文本 */
			const sx = e.clientX;
			const sy = e.clientY;
			const box = document.createElement("div");
			box.className = "stc-marquee";
			box.style.position = "fixed";
			box.style.left = sx + "px";
			box.style.top = sy + "px";
			box.style.width = "0px";
			box.style.height = "0px";
			if (document.body && document.body.appendChild) document.body.appendChild(box);
			let moved = false;
			const onMove = function (ev) {
				const x = ev.clientX;
				const y = ev.clientY;
				if (Math.abs(x - sx) > 4 || Math.abs(y - sy) > 4) moved = true;
				box.style.left = Math.min(x, sx) + "px";
				box.style.top = Math.min(y, sy) + "px";
				box.style.width = Math.abs(x - sx) + "px";
				box.style.height = Math.abs(y - sy) + "px";
			};
			const onUp = function (ev) {
				if (document.removeEventListener) {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onUp);
				}
				if (box.remove) box.remove();
				if (!moved) return; /* 原地单击：交给卡片自己的 click 去单刷 */
				const l = Math.min(sx, ev.clientX);
				const t = Math.min(sy, ev.clientY);
				const r = Math.max(sx, ev.clientX);
				const btm = Math.max(sy, ev.clientY);
				let n = 0;
				const hitCards = [];
				const cardEls = board.querySelectorAll(".stc-card");
				for (const cel of cardEls) {
					const rect = cel.getBoundingClientRect ? cel.getBoundingClientRect() : null;
					if (!rect) continue;
					const hit = rect.left < r && rect.right > l && rect.top < btm && rect.bottom > t;
					if (!hit) continue;
					const idx = toInt(cel.dataset.idx, -1);
					const hitCard = self.cards[idx];
					if (hitCard && self.applyBrushSync(hitCard)) {
						hitCards.push(hitCard);
						n++;
					}
				}
				if (n) {
					self._marqueeJustRan = true;
					window.setTimeout(function () {
						self._marqueeJustRan = false;
					}, 250);
					/* ：落盘后只原地改命中卡的宽高样式，不整版重绘（防幕布上移） */
					self.persist().then(function () {
						self.refreshCardSizesInPlace(hitCards);
					});
					new Notice("格式刷已应用到 " + n + " 张卡。");
				}
			};
			if (document.addEventListener) {
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
			}
		});
	}

	/* ---------------- 拖拽排序 ---------------- */

	bindCardDrag(el, idx, colNo) {
		const self = this;
		el.addEventListener("dragstart", function (e) {
			if (el.hasClass("stc-resizing")) {
				e.preventDefault();
				return;
			}
			self.dragIndex = idx;
			/* ：批量模式下拖选中的卡＝整组一起走（组按板面顺序） */
			if (self.batch && self.batch.picked && self.batch.picked.has(self.cards[idx])) {
				self.dragGroup = self.cards.filter((c) => self.batch.picked.has(c));
			} else {
				self.dragGroup = null;
			}
			el.addClass("stc-dragging");
			try {
				e.dataTransfer.setData("text/plain", String(idx));
				e.dataTransfer.effectAllowed = "move";
			} catch (err) {
				/* ignore */
			}
			self.startDragWheel(); /* ：拖拽期间接管滚轮，卡片能拖到屏幕外 */
		});
		el.addEventListener("dragend", function () {
			self.dragIndex = -1;
			self.dragGroup = null;
			self.stopDragWheel(); /* ：拖拽结束解除滚轮接管 */
			self.clearDropMarks();
			el.removeClass("stc-dragging");
			window.setTimeout(function () {
				self.suppressClick = false;
			}, 120);
			self.suppressClick = true;
		});
		el.addEventListener("dragover", function (e) {
			if (self.dragIndex < 0) return;
			e.preventDefault();
			e.stopPropagation();
			const mode = dropMode(el, e);
			const col = toInt(colNo, 0);
			const m = self.dropMark;
			if (m && m.type === "card" && m.idx === idx && m.mode === mode) return;
			self.clearDropMarks();
			el.addClass(
				mode === "swap" ? "stc-drop-swap" : mode === "after" ? "stc-drop-after" : "stc-drop-before"
			);
			/* 插入：在两张卡之间画一条线（而不是给卡片描边）；
			   互换：被覆盖的那张整张加深。两种提示一眼能分开。 */
			if (mode !== "swap") self.showInsLine(el, mode === "after");
			self.dropMark = { type: "card", idx: idx, mode: mode, col: col };
		});
		el.addEventListener("drop", async function (e) {
			e.preventDefault();
			e.stopPropagation();
			const mark = self.dropMark;
			self.clearDropMarks();
			if (self.dragIndex < 0 || !mark || mark.type !== "card") return;
			/* 单卡：中腹 → 两张卡互换；靠边 → 插到前面 / 后面。
			   ：批量组与单卡完全同款 —— 中腹 = 整组与该卡互换（组落到该卡
			   原位、该卡退到组起点），靠边 = 整组插到该卡前 / 后。
			   目标卡本身是组内成员时互换无意义，按插入处理。 */
			if (mark.mode === "swap") {
				if (self.dragGroup && self.dragGroup.length) {
					const tgt = self.cards[mark.idx];
					if (!(tgt && self.batch && self.batch.picked.has(tgt))) {
						await self.swapGroupWithCard(mark.idx);
						return;
					}
				} else {
					await self.swapCards(self.dragIndex, mark.idx);
					return;
				}
			}
			const destIdx = mark.mode === "after" ? mark.idx + 1 : mark.idx;
			const target = self.cards[mark.idx];
			const act = target ? target.act(self.keys()) : "待定";
			if (self.dragGroup && self.dragGroup.length) {
				await self.moveBatchTo(destIdx, act === "待定" ? "" : act, mark.col);
				return;
			}
			/* 拖到哪一列的卡上，就进哪一列 */
			await self.moveCard(self.dragIndex, destIdx, act === "待定" ? "" : act, mark.col);
		});
	}

	/* 拖到**空白处**（某一列的空位、或整个卡片区的空处）时怎么落。
	   只在卡片区挂**一个**监听：靠 e.target.closest(".stc-col") 判断落在哪一列。
	   以前是每一列各挂一个、外面再挂一个 —— 事件会冒泡，外层那一个会把内层的
	   标记覆盖成「不限列」，结果就是**拖到空列没反应**（用户报的 bug）。 */
	bindRowDrop(area, actKey) {
		const self = this;

		/* 落在哪一列：
		   ① 先看指针底下是不是某条列栈（.stc-col）；
		   ② 不是（落在列与列之间的空白、或整行右侧的空处）就**按坐标**找横向最近的那一列。
		   以前只看 ①，落空就返回 0（＝不限列）→ 卡就只能留在原列，
		   所以「第 1 列的卡拖不进空着的第 2 列」（用户报的 bug）。 */
		const colElAt = (target, clientX) => {
			const hit = target && target.closest ? target.closest(".stc-col") : null;
			if (hit) return hit;
			const cols = area.querySelectorAll(".stc-col");
			if (!cols.length) return null;
			const x = toInt(clientX, NaN);
			if (isNaN(x)) return cols[0];
			let best = null;
			let bestD = Infinity;
			for (let i = 0; i < cols.length; i++) {
				const r = cols[i].getBoundingClientRect ? cols[i].getBoundingClientRect() : null;
				if (!r) return cols[i];
				const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
				if (d < bestD) {
					bestD = d;
					best = cols[i];
				}
			}
			return best || cols[0];
		};
		const colOf = (target, clientX) => {
			const el = colElAt(target, clientX);
			return el ? toInt(el.dataset.col, 0) : 0;
		};

		area.addEventListener("dragover", function (e) {
			if (self.dragIndex < 0) return;
			if (e.target && e.target.closest && e.target.closest(".stc-card")) return;
			e.preventDefault();
			const col = colOf(e.target, e.clientX);
			const m = self.dropMark;
			if (!m || m.type !== "row" || m.act !== actKey || m.col !== col) {
				self.clearDropMarks();
				const el = colElAt(e.target, e.clientX);
				if (el) el.addClass("stc-drop-col");
				else area.addClass("stc-drop-area");
				self.dropMark = { type: "row", act: actKey, col: col };
			}
		});
		area.addEventListener("drop", async function (e) {
			e.preventDefault();
			const mark = self.dropMark || {
				type: "row",
				act: actKey,
				col: colOf(e.target, e.clientX),
			};
			self.clearDropMarks();
			if (self.dragIndex < 0 || !mark || mark.type !== "row") return;
			const c = toInt(mark.col, 0);
			/* ：批量拖组 → 整组落到该列末尾 */
			if (self.dragGroup && self.dragGroup.length) {
				await self.moveBatchToColumnEnd(actKey, c);
				return;
			}
			await self.moveCard(self.dragIndex, self.appendIndex(actKey, c), actKey, c);
		});
		/* 拖到列上但落在「＋」上时，dragover 的 target 是「＋」，closest 一样能拿到列 */
	}

	/* （用户报）：HTML5 拖拽期间浏览器不响应滚轮——卡片拖不到屏幕外。
	   拖拽期间接管滚轮：手动滚动滚动容器（面板模式滚案板区，内嵌模式滚笔记视图），
	   滚完用最后已知指针位置重算落点提示（插入线跟着走）。拖拽结束自动解除。
	   （用户要求）：单卡拖拽和批量多选拖拽都能一边拖一边用滚轮把幕布
	   上下翻，把卡拖到下面的幕里；拖拽结束后接管自动解除。 */
	startDragWheel() {
		const self = this;
		if (this._dragWheelOn) return;
		this._dragLastXY = { x: 0, y: 0 };
		this._dragWheelOn = function (ev) {
			if (self.dragIndex < 0) {
				self.stopDragWheel();
				return;
			}
			if (ev.cancelable) ev.preventDefault();
			self._dragLastXY = { x: ev.clientX, y: ev.clientY };
			self.scrollDuringDrag(ev.deltaY || 0);
		};
		if (document.addEventListener) document.addEventListener("wheel", this._dragWheelOn, { passive: false });
	}

	stopDragWheel() {
		if (this._dragWheelOn && document.removeEventListener) document.removeEventListener("wheel", this._dragWheelOn);
		this._dragWheelOn = null;
	}

	/* （用户报）：原来只认「案板容器 + 最近一个祖先」，内嵌模式里笔记
	   真正的滚动容器常是更外层的 .markdown-preview-view / .cm-scroller，
	   于是拖拽时滚轮滚不动、卡拖不到下面的幕里。
	   改成：从案板容器起向上收集**所有**真正可滚的祖先（去重），逐个滚；
	   都滚不动时兜底滚 window。滚完用最后已知指针位置重算落点提示。 */
	dragScrollTargets() {
		const out = [];
		const push = (el) => {
			if (!el || out.indexOf(el) >= 0) return;
			if (el.scrollHeight > el.clientHeight + 1) out.push(el);
		};
		/* 面板模式：案板容器自己滚；内嵌模式：它不滚，交给祖先 */
		push(this.root && this.root.querySelector ? this.root.querySelector(".stc-board") : null);
		/* 沿 DOM 向上把所有可滚祖先都收进来（阅读视图 scroller、实时预览 cm-scroller、
		   笔记视图容器、侧栏 workspace 等），命中即止于 body */
		let node = this.root ? this.root.parentElement : null;
		let guard = 0;
		while (node && node !== document.body && guard < 40) {
			try {
				push(node);
			} catch (e) {
				/* ignore */
			}
			node = node.parentElement;
			guard++;
		}
		return out;
	}

	scrollDuringDrag(deltaY) {
		const d = toInt(deltaY, 0);
		if (!d || !this.root) return;
		const targets = this.dragScrollTargets();
		let scrolled = false;
		for (const t of targets) {
			const before = t.scrollTop;
			t.scrollTop = before + d;
			if (t.scrollTop !== before) scrolled = true;
		}
		/* 一个都没滚（理论上不该发生）——兜底滚窗口，至少保证卡能往下走 */
		if (!scrolled && targets.length === 0) {
			const before = window.scrollY || 0;
			try {
				window.scrollTo(0, before + d);
				scrolled = (window.scrollY || 0) !== before;
			} catch (e) {
				/* ignore */
			}
		}
		if (scrolled) this.refreshDropMarkAt(this._dragLastXY.x, this._dragLastXY.y);
	}

	refreshDropMarkAt(x, y) {
		try {
			if (typeof document === "undefined" || !document.elementFromPoint || typeof DragEvent !== "function") return;
			let tgt = document.elementFromPoint(x, y);
			if (!tgt) return;
			if (tgt.classList && tgt.classList.contains("stc-insline")) {
				/* 插入线挡在指针下会吃掉落点判定——先藏掉再取真正的目标 */
				tgt.style.display = "none";
				tgt = document.elementFromPoint(x, y);
			}
			if (!tgt) return;
			tgt.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
		} catch (e) {
			/* 合成事件失败就等下一次真实 mousemove 修正 */
		}
	}

	clearDropMarks() {
		if (!this.root) return;
		const marked = this.root.querySelectorAll(
			".stc-drop-before,.stc-drop-after,.stc-drop-swap,.stc-drop-area,.stc-drop-col"
		);
		for (let i = 0; i < marked.length; i++) {
			marked[i].removeClass("stc-drop-before");
			marked[i].removeClass("stc-drop-after");
			marked[i].removeClass("stc-drop-swap");
			marked[i].removeClass("stc-drop-area");
			marked[i].removeClass("stc-drop-col");
		}
		this.dropMark = null;
		this.hideInsLine();
	}

	/* 插到「这一幕 + 这一列」的最后一张卡之后。
	   col = 0 表示不限列（插到该幕末尾即可，卡的列不动）。 */
	appendIndex(actKey, col) {
		const list = this.cards;
		const keys = this.keys();
		const c = toInt(col, 0);
		let last = -1;
		for (let i = 0; i < list.length; i++) {
			if (list[i].act(keys) !== actKey) continue;
			if (c > 0 && list[i].col(MAX_COLS) !== c) continue;
			last = i;
		}
		if (last >= 0) return last + 1;
		const at = keys.indexOf(actKey);
		if (at < 0) return list.length;
		for (let i = 0; i < list.length; i++) {
			const a = keys.indexOf(list[i].act(keys));
			if (a > at || a < 0) return i;
		}
		return list.length;
	}

	/* 两张卡互换位置：连「幕」和「列」一起换，所以跨行、跨列也是真的对调。 */
	async swapCards(from, to) {
		const a = this.cards[from];
		const b = this.cards[to];
		if (!a || !b || from === to) return;
		const keys = this.keys();
		const actA = a.act(keys);
		const actB = b.act(keys);
		const colA = a.col(MAX_COLS);
		const colB = b.col(MAX_COLS);
		a.set(K.act, actB === "待定" ? "" : actB);
		b.set(K.act, actA === "待定" ? "" : actA);
	a.setCol(colB);
	b.setCol(colA);
	this.cards[from] = b;
	this.cards[to] = a;
	await this.persist();
	this.render();
}

/* ：批量组 ↔ 单张卡互换（与单卡拖拽「中腹互换」完全同款语义）：
   组整体落到该卡原位置（幕/列跟着换过去），该卡退到组原先的起点。 */
async swapGroupWithCard(targetIdx) {
	if (!this.batch || !this.batch.picked.size) return;
	const t = toInt(targetIdx, -1);
	const target = this.cards[t];
	if (!target) return;
	const picked = this.batch.picked;
	if (picked.has(target)) return; /* 目标在组里，互换无意义（外层已按插入处理） */
	const sel = this.cards.filter((c) => picked.has(c)); /* 按板面顺序 */
	const g0 = this.cards.indexOf(sel[0]);
	const keys = this.keys();
	const tAct = target.act(keys);
	const tCol = target.col(MAX_COLS);
	const gAct = sel[0].act(keys);
	const gCol = sel[0].col(MAX_COLS);
	const out = [];
	for (let i = 0; i < this.cards.length; i++) {
		const c = this.cards[i];
		if (picked.has(c)) {
			if (i === g0) out.push(target); /* 组的起点让给单卡 */
			continue;
		}
		if (c === target) {
			for (const g of sel) out.push(g); /* 组整体落到单卡原位 */
			continue;
		}
		out.push(c);
	}
	this.cards.splice(0, this.cards.length, ...out);
	/* 幕/列对调：组成员换到单卡那边的幕/列，单卡换到组起点那边的幕/列 */
	for (const g of sel) {
		g.set(K.act, tAct === "待定" ? "" : tAct);
		g.setCol(tCol);
	}
	target.set(K.act, gAct === "待定" ? "" : gAct);
	target.setCol(gCol);
	await this.persist();
	this.render();
	new Notice("已互换 " + sel.length + " 张 ↔ 1 张。");
}

/* （用户报）：幕移动后卡号没刷新——编号按数组（文件）顺序算，幕只是显示
   顺序变了。现在把卡片数组也按幕的显示顺序重排（同幕内相对顺序不变，收卡盘排
   最后），文件里的卡序、卡面编号、汇总编号从此和板面显示一致。 */
sortCardsByActs() {
	const ks = this.keys();
	const order = {};
	ks.forEach((k, i) => (order[k] = i));
	const rank = (c) => {
		const a = c.act(ks);
		return Object.prototype.hasOwnProperty.call(order, a) ? order[a] : ks.length;
	};
	/* 稳定排序：同幕的卡保持原有先后，列的分配不受影响（每张卡自己记列号） */
	this.cards
		.map((c, i) => ({ c: c, i: i }))
		.sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i)
		.forEach((x, i) => (this.cards[i] = x.c));
}

	async moveCard(from, dest, actKey, col) {
		if (from < 0 || from >= this.cards.length) return;
		const card = this.cards[from];
		this.cards.splice(from, 1);
		let d = dest;
		if (from < dest) d = dest - 1;
		if (d < 0) d = 0;
		if (d > this.cards.length) d = this.cards.length;
		if (actKey && card.act(this.keys()) !== actKey) card.set(K.act, actKey);
		const c = toInt(col, 0);
		if (c > 0) card.setCol(c);
		this.cards.splice(d, 0, card);
		await this.persist();
		this.render();
	}

	/* ---------------- 批量选择/移动（； 起拖拽整组走） ---------------- */

	batchTap(card) {
		/* 多选：选中 / 取消（渲染时按 picked 加高亮）。移动靠拖：拖选中的卡＝整组走。
		   （用户报）：只原地更新这张卡的高亮和可拖性，不整版重绘（防幕布位移）。 */
		if (!this.batch) return;
		if (this.batch.picked.has(card)) this.batch.picked.delete(card);
		else this.batch.picked.add(card);
		const idx = this.cards.indexOf(card);
		let el = null;
		try {
			el = this.root.querySelector('.stc-card[data-idx="' + idx + '"]');
		} catch (e) {
			el = null;
		}
		if (el) {
			const picked = this.batch.picked.has(card);
			if (picked) {
				el.addClass("stc-picked");
				el.draggable = true;
			} else {
				el.removeClass("stc-picked");
				el.draggable = false;
			}
		}
	}

	/* ：批量模式进/出时原地更新所有卡的可拖性与高亮类（不整版重绘） */
	setBatchCardsDom(on) {
		try {
			const boardEl = this.root && this.root.querySelector ? this.root.querySelector(".stc-board") : null;
			if (!boardEl) return;
			const brushOn = !!(this.plugin.brush && this.plugin.brush.on);
			boardEl.querySelectorAll(".stc-card").forEach((cel) => {
				cel.draggable = on ? false : !brushOn;
				if (on) {
					if (cel.addClass) cel.addClass("stc-batch-pick");
				} else if (cel.removeClass) {
					cel.removeClass("stc-batch-pick");
					cel.removeClass("stc-picked");
				}
			});
		} catch (e) {
			/* ignore */
		}
	}

	/* ：参与汇总状态变化后，只原地更新全板卡面序号（不整版重绘）。
	   序号是跨幕连续的，所以全板都要刷新；_noMap 同步更新，汇总导出编号保持新鲜。 */
	refreshNumbersInPlace() {
		try {
			const noMap = buildNoMap(this.cards, this.meta);
			this._noMap = noMap;
			const boardEl = this.root && this.root.querySelector ? this.root.querySelector(".stc-board") : null;
			if (!boardEl) return;
			boardEl.querySelectorAll(".stc-card").forEach((cel) => {
				const idx = toInt(cel.dataset && cel.dataset.idx, -1);
				const card = idx >= 0 ? this.cards[idx] : null;
				if (!card) return;
				const no = noMap.get(card);
				const topEl = cel.querySelector(".stc-card-top");
				if (!topEl) return;
				let numEl = topEl.querySelector(".stc-num");
				if (no) {
					if (!numEl) {
						numEl = document.createElement("span");
						numEl.className = "stc-num";
						topEl.insertBefore(numEl, topEl.firstChild);
					}
					numEl.setText(no);
				} else if (numEl) {
					numEl.remove();
				}
			});
		} catch (e) {
			this.render(); /* 兜底：原地刷新失败就走整版重绘 */
		}
	}

	/* 把整组选中卡插到 destIdx 位置（保持组内板面顺序），列号统一改成 col */
	async moveBatchTo(destIdx, actKey, col) {
		if (!this.batch || !this.batch.picked.size) return;
		const picked = this.batch.picked;
		/* 按板面顺序取选中卡：移动后保持它们原本的先后关系 */
		const sel = this.cards.filter((c) => picked.has(c));
		/* ：destIdx 是原数组里的位置；先数出排在它前面的已选卡，
		   移除后目标位置要相应左移，否则组会插到目标卡前面好几张（落点漂移） */
		let d = destIdx;
		for (const c of sel) {
			const i = this.cards.indexOf(c);
			if (i > -1 && i < d) d--;
		}
		for (const c of sel) {
			const i = this.cards.indexOf(c);
			if (i > -1) this.cards.splice(i, 1);
		}
		let at = Math.max(0, Math.min(d, this.cards.length));
		for (const c of sel) {
			this.cards.splice(at, 0, c);
			at++;
			if (actKey && c.act(this.keys()) !== actKey) c.set(K.act, actKey === "待定" ? "" : actKey);
			const cc = toInt(col, 0);
			if (cc > 0) c.setCol(cc);
		}
		await this.persist();
		this.render();
		new Notice("已移动 " + sel.length + " 张卡。");
	}

	async moveBatchToColumnEnd(actKey, col) {
		if (!this.batch || !this.batch.picked.size) return;
		await this.moveBatchTo(this.appendIndex(actKey, col), actKey, col);
	}

	/* ---------------- 增删 ---------------- */

	async addCard(actKey, col) {
		const c = new Card();
		c.set(K.act, actKey);
		c.setCol(toInt(col, 1));
		/* （用户要求·方案一）：新建卡尺寸跟随**同幕同列最后一张卡**——
		   以案板文件为真相源，拖拽/弹窗/格式刷/手改文件后都自动一致；
		   同幕同列还没有卡时用默认尺寸 300×176 */
		const keysNow = this.keys();
		const wantCol = toInt(col, 1);
		for (let i = this.cards.length - 1; i >= 0; i--) {
			const p = this.cards[i];
			if (p.act(keysNow) !== actKey || p.col(MAX_COLS) !== wantCol) continue;
			/* 没写尺寸的卡（走默认值）不当参照，继续往前找有明确尺寸的 */
			if (!p.get(K.width) && !p.get(K.height)) continue;
			c.set(K.width, String(p.width()));
			c.set(K.height, String(p.height()));
			break;
		}
		c.set(K.beat, "");
		c.set(K.scene, "");
		/* （用户指定）：「事」默认放一个空格占位——卡面看着是空白，
		   但这一行可点击直接写，不会再出现新卡没法编辑的情况。 */
		c.set(K.action, " ");
		c.set(K.pm, "");
		c.set(K.conflict, "");
		const at = this.appendIndex(actKey, toInt(col, 0));
		this.cards.splice(at, 0, c);
		await this.persist();
		this.render();
		/* （用户指定）：新建直接落一张空卡，不再自动弹索引卡弹窗；
		   想填内容就点卡片右上角的圆点（或双击卡片）。 */
	}

	async insertAnchors() {
		if (this.cards.length) {
			new Notice("案板里已经有卡了，先把它们清空或另建一块案板再插锚点。");
			return;
		}
		this.cards = beatAnchorCards(this.meta);
		await this.persist();
		this.render();
		new Notice("已插入 15 张空白节拍卡，逐张填满即可。");
	}
	/* （用户要求）：导入模板——选任一已有案板，原样复制它的**幕布布局＋卡片布局**
	   （幕名/顺序/列数/铰链 + 每张卡的 幕/列/宽/高/节拍），**不导入卡片内容**
	   （场/事/＋－/＞＜/色 一律留空，幕头备注也不带）。当前板面有卡时需二次确认。 */
	async importTemplateLayout(file) {
		if (!file) return;
		if (this.cards.length && !this._tplConfirmed) {
			new Notice(
				"当前案板已有 " + this.cards.length + " 张卡。再点一次「导入模板」＝ 清空当前板面，按模板重建布局。"
			);
			this._tplConfirmed = true;
			return;
		}
		this._tplConfirmed = false;
		const raw = await this.app.vault.read(file);
		const b = boardFromRaw(raw);
		if (!b.cards.length && !hasMetaInFile(raw)) {
			new Notice("「" + file.name + "」里没有案板数据，换一个文件。");
			return;
		}
		const cl = cloneBoardLayout(b.cards, b.meta);
		this.meta = cl.meta;
		this.cards = cl.cards;
		await this.persist();
		this.render();
		new Notice(
			"已按「" + file.name + "」导入布局：" + this.meta.keys().length + " 幕 / " + this.cards.length + " 张空白卡（卡片内容不导入）。"
		);
	}
}

/* ---------------------------------------------------------------- 侧栏面板 */

class BoardView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.engine = new BoardEngine(plugin, this.contentEl, {});
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "卡片式写作案板";
	}

	getIcon() {
		return "layout-grid";
	}

	get cards() {
		return this.engine.cards;
	}

	async onOpen() {
		await this.engine.load();
		this.engine.render();
	}

	async onClose() {
		this.contentEl.empty();
	}

	async reload() {
		await this.engine.reload();
	}

	render() {
		this.engine.render();
	}
}

/* ---------------------------------------------------------------- 插件 */

class SaveTheCatBoardPlugin extends Plugin {
	async onload() {
		this.writing = false;
		/* ：所有 BoardEngine 实例（主视图 + 笔记里嵌入的每个案板）都登记在这里，
		   文件被外部改动时按 filePath 一起重载，保证插件区/案板区/无格式区三处同步 */
		this.engines = new Set();
		/* 格式刷状态：on=开着；active=已经记住基准尺寸；w/h=基准宽高；src=基准那张卡 */
		this.brush = { on: false, active: false, w: 0, h: 0, src: null };
		/* ：宽/高锁定（拖拽把手受限）。w=锁宽、h=锁高；会话内记住，不写设置 */
		this.locks = { w: false, h: false };
		await this.loadSettings();

		this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));

		this.addRibbonIcon("layout-grid", "打开卡片式写作案板", () => this.activateView());

		this.addCommand({
			id: "open-xw-card-board",
			name: "打开案板面板",
			callback: () => this.activateView(),
		});
		this.addCommand({
			id: "new-xw-card-board",
			name: "新建案板文件",
			callback: () => this.createNewBoard(),
		});
		this.addCommand({
			id: "insert-anchors",
			name: "在面板里插入 15 张空白节拍卡",
			callback: async () => {
				const v = this.view();
				if (!v) return this.activateView();
				await v.engine.insertAnchors();
			},
		});
		this.addCommand({
			id: "import-template",
			name: "导入模板（复制幕布＋卡片布局，不含内容）",
			callback: () => {
				const v = this.view();
				if (!v) return this.activateView();
				new BoardFileModal(this.app, this, {
					pickTitle: "选择要当模板的案板文件……",
					onPick: (f) => v.engine.importTemplateLayout(f),
				}).open();
			},
		});
		this.addCommand({
			id: "pick-xw-card-board",
			name: "切换案板文件",
			callback: () => new BoardFileModal(this.app, this).open(),
		});
		this.addCommand({
			id: "check-xw-card-board",
			name: "案板自检",
			callback: async () => {
				const v = this.view();
				if (v) await v.reload();
				this.selfCheck(v ? v.cards : [], v ? v.engine.meta : null);
			},
		});

		/* 笔记里放 ```xw-card-board 代码块 → 阅读模式直接渲染成案板 */
		this.registerMarkdownCodeBlockProcessor("xw-card-board", async (source, el, ctx) => {
			/* 代码块外层的 <pre>/<code> 会带来等宽字体和 white-space:pre，
			   会把案板挤变形——给这几位都打上 stc-embed-host，用 CSS 抵消掉。 */
			const hosts = [el];
			const up = (sel) => {
				try {
					const n = el.closest ? el.closest(sel) : null;
					if (n) hosts.push(n);
				} catch (e) {
					/* ignore */
				}
			};
			up("pre");
			up("code");
			for (const h of hosts) {
				if (h && h.addClass) h.addClass("stc-embed-host");
			}

			const f = this.app.vault.getAbstractFileByPath(normalizePath(ctx.sourcePath));
			if (!(f instanceof TFile)) {
				el.createEl("div", { cls: "stc-embed-missing", text: "找不到这个文件。" });
				return;
			}
			const eng = new BoardEngine(this, el, { filePath: f.path, inline: true });
			await eng.load();
			eng.render();
		});

		/* 文件右键菜单：用案板打开 */
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) =>
					item
						.setTitle("用作卡片式写作案板")
						.setIcon("layout-grid")
						.onClick(async () => {
							await this.setBoardFile(file.path);
						})
				);
			})
		);

		this.addSettingTab(new BoardSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				/* ：文件被改动时，把指向它的所有引擎（主视图 + 各嵌入案板）都重载，
				   让插件区/案板区/无格式原文三处收敛到同一份内容；
				   - 正在内联编辑的引擎先打标记，编辑完再合并，不打断输入；
				   - 自己正在写回的引擎跳过（它已经重绘过自己）；
				   - 容器已从文档移除的陈旧嵌入引擎直接忽略，避免反复空重载。 */
				for (const eng of this.engines) {
					if (!eng || !eng.filePath) continue;
					if (eng.filePath !== file.path) continue;
					if (eng.root && eng.root.ownerDocument && !eng.root.ownerDocument.contains(eng.root)) continue;
					if (eng._editing) {
						eng._externalDirty = true;
						continue;
					}
					if (eng._writing) continue;
					window.clearTimeout(eng._reloadTimer);
					eng._reloadTimer = window.setTimeout(() => eng.reload(), 600);
				}
			})
		);
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	view() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (!leaves.length) return null;
		return leaves[0].view;
	}

	async activateView() {
		const workspace = this.app.workspace;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			let l = workspace.getRightLeaf(false);
			if (l && typeof l.then === "function") l = await l;
			leaf = l || workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
		const v = this.view();
		if (v) await v.reload();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		syncCustomBeats(this.settings.customBeats);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getBoardFile() {
		if (!this.settings.boardFile) return null;
		const af = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.boardFile));
		return af instanceof TFile ? af : null;
	}

	async setBoardFile(path) {
		this.settings.boardFile = path;
		await this.saveSettings();
		const v = this.view();
		if (v) await v.reload();
		else await this.activateView();
		new Notice("已把案板指向：" + path);
	}

	colorMapObj() {
		const out = {};
		const txt = this.settings.colorMap || "";
		for (const line of txt.split(/\r?\n/)) {
			const t = line.trim();
			if (!t || t[0] === "#") continue;
			const m = /^(.+?)\s*[=:：]\s*(#[0-9a-fA-F]{3,8})\s*$/.exec(t);
			if (m) out[m[1].trim()] = m[2];
		}
		return out;
	}

	async writeColorMap(obj) {
		const lines = [];
		for (const k of Object.keys(obj)) {
			if (!k) continue;
			lines.push(k + "=" + obj[k]);
		}
		this.settings.colorMap = lines.join("\n");
		await this.saveSettings();
		this.repaint();
	}

	async setColor(name, color) {
		const n = String(name || "").trim();
		if (!n) return;
		const m = this.colorMapObj();
		m[n] = color;
		await this.writeColorMap(m);
	}

	async ensureColorName(name) {
		const n = String(name || "").trim();
		if (!n) return;
		const m = this.colorMapObj();
		if (m[n]) return;
		m[n] = autoColor(n);
		await this.writeColorMap(m);
	}

	/* 把一条线从色彩编码表里删掉。返回「真的删到了没有」。
	   注意：只是去掉「指定颜色」，用这个名字的卡会回到自动色，不会丢名字。 */
	async removeColorName(name) {
		const n = String(name || "").trim();
		if (!n) return false;
		const m = this.colorMapObj();
		if (m[n] === undefined) return false;
		delete m[n];
		await this.writeColorMap(m);
		return true;
	}

	/* 下拉选项：色表里有的 + 当前卡用过的 + 正在用的这个 */
	colorNames(current) {
		const out = Object.keys(this.colorMapObj());
		const push = (n) => {
			if (n && out.indexOf(n) < 0) out.push(n);
		};
		push(current);
		for (const c of this.allCards()) push(String(c.get(K.color)).trim());
		return out;
	}

	allCards() {
		const v = this.view();
		if (v) return v.cards;
		const m = this._inlineCards;
		return m || [];
	}

	/* 扫案板文件，把卡片上出现过的「色」都收出来 */
	async collectColorNames() {
		const out = [];
		const push = (n) => {
			if (n && out.indexOf(n) < 0) out.push(n);
		};
		for (const c of this.allCards()) push(String(c.get(K.color)).trim());
		try {
			const f = this.getBoardFile();
			if (f) {
				const cards = cardsFromRaw(await this.app.vault.read(f));
				for (const c of cards) push(String(c.get(K.color)).trim());
			}
		} catch (e) {
			/* 读不到就算了，色表照样能编辑 */
		}
		return out;
	}

	async createNewBoard() {
		const dir = (this.settings.boardFolder || "").trim().replace(/^\/+|\/+$/g, "");
		if (dir && !this.app.vault.getAbstractFileByPath(normalizePath(dir))) {
			try {
				await this.app.vault.createFolder(normalizePath(dir));
			} catch (e) {
				/* 目录已存在或无权限，交给后面 create 报错 */
			}
		}
		let i = 0;
		let path = "";
		while (true) {
			const name = i === 0 ? "案板_新作品.md" : "案板_新作品" + (i + 1) + ".md";
			path = normalizePath((dir ? dir + "/" : "") + name);
			if (!this.app.vault.getAbstractFileByPath(path)) break;
			i++;
		}
		try {
			const f = await this.app.vault.create(path, newBoardTemplate("新作品"));
			this.settings.boardFile = f.path;
			await this.saveSettings();
			await this.activateView();
			new Notice("已新建案板：" + f.path);
		} catch (e) {
			new Notice("新建失败：" + e.message);
		}
	}

	selfCheck(cards, meta) {
		const m = meta || new BoardMeta();
		const warns = validate(cards || [], { meta: m });
		console.log("[卡片式写作案板] 自检报告\n" + (warns.length ? warns.join("\n") : "（全绿）"));
		new SelfCheckModal(this.app, warns, cards || [], m).open();
	}

	repaint() {
		const v = this.view();
		if (v) v.render();
	}
}

/* ---------------------------------------------------------------- 汇总导出 */

/* 汇总弹窗：知乎风正文（编号去零），一键复制。 */
class SummaryModal extends Modal {
	constructor(app, text) {
		super(app);
		this.text = text || "";
	}

	onOpen() {
		const el = this.contentEl;
		el.addClass("stc-summary");
		/* （用户要求）：标题「知乎风」换成字数——括号里直接给总字数，
		   按去掉空格/换行后的全部字符计，标点符号全部算在内 */
		const charCount = String(this.text || "").replace(/\s/g, "").length;
		el.createEl("h3", { text: "正文汇总（共 " + charCount + " 字）" });
		el.createEl("div", {
			cls: "stc-check-sub",
			text: "编号即卡片编号（去了前导零）。「导语」卡固定编号 0、排最前。没写「事」的卡不参与。字数含标点符号，不含空格换行。",
		});
		const box = el.createEl("pre", { cls: "stc-summary-body", text: this.text || "（还没有卡写过「事」。）" });
		box.setAttr("title", "正文内容，可直接选中复制");
		const bar = el.createDiv({ cls: "stc-check-btns" });
		const cp = bar.createEl("button", { cls: "mod-cta", text: "复制全文" });
		cp.addEventListener("click", async () => {
			try {
				if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(this.text);
					new Notice("已复制，直接贴走就行。");
				} else {
					new Notice("这个环境不支持自动复制，手动选中上面文字即可。");
				}
			} catch (e) {
				new Notice("复制失败，手动选中上面文字即可。");
			}
		});
		/* （用户指定）：右上角自带 X 关闭，左下角的「关闭」按钮删掉，不重复 */
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ---------------------------------------------------------------- 自检报告 */

/* 自检报告弹框。
   用 Obsidian 自己的 Modal —— 配色天然跟主题，不用自己写 CSS。
   （之前用 Notice + 自定义 CSS，主题没跟上，用户看到的还是黑底白字。） */
class SelfCheckModal extends Modal {
	constructor(app, warns, cards, meta) {
		super(app);
		this.warns = warns || [];
		this.cards = cards || [];
		this.meta = meta || new BoardMeta();
	}

	onOpen() {
		const el = this.contentEl;
		el.addClass("stc-check");
		const ok = this.warns.length === 0;

		let good = 0;
		for (const c of this.cards) if (!checkCard(c).length) good++;

		el.createEl("h3", { text: ok ? "自检通过" : "自检：" + this.warns.length + " 条待办" });
		el.createEl("div", {
			cls: "stc-check-sub",
			text: ok
				? "共 " + this.cards.length + " 张卡：每张都是一场戏、一次情绪转变、一个冲突，行末铰链也对位。可以开始写了。"
				: "共 " + this.cards.length + " 张卡，其中 " + good + " 张完全合规。下面这些不影响你继续写，最好一条条消掉。",
		});

		if (!ok) {
			const ul = el.createEl("ul", { cls: "stc-check-list" });
			for (const w of this.warns) {
				const parts = String(w).split("\n");
				const li = ul.createEl("li", { text: parts[0].replace(/\s+$/, "") });
				for (let i = 1; i < parts.length; i++) {
					const t = parts[i].replace(/^\s*·\s*/, "").trim();
					if (t) li.createEl("div", { cls: "stc-check-subitem", text: t });
				}
			}
			const cp = el.createEl("button", { cls: "stc-check-copy", text: "复制清单" });
			cp.addEventListener("click", async () => {
				const text = this.warns.join("\n");
				try {
					if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(text);
						new Notice("清单已复制。");
					} else {
						new Notice("这个环境不支持自动复制，可以手动选中文字。");
					}
				} catch (e) {
					new Notice("复制失败，可以手动选中文字。");
				}
			});
		}

		const bar = el.createDiv({ cls: "stc-check-btns" });
		const b = bar.createEl("button", { cls: "mod-cta", text: "知道了" });
		b.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ---------------------------------------------------------------- 设置面板 */

class BoardSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const c = this.containerEl;
		c.empty();
		c.createEl("h2", { text: "卡片式写作案板 · 设置" });

		new Setting(c)
			.setName("案板文件")
			.setDesc(
				"存放索引卡的 Markdown 文件。面板顶部点文件名也能直接切换。（不用填写此栏，插件会自动填写）"
			)
			.addText((t) =>
				t.setValue(this.plugin.settings.boardFile).onChange(async (v) => {
					this.plugin.settings.boardFile = v.trim();
					await this.plugin.saveSettings();
				})
			)
			.addButton((b) => b.setButtonText("选择").onClick(() => new BoardFileModal(this.app, this.plugin).open()));

		new Setting(c)
			.setName("新建案板的存放目录")
			.setDesc(
				"多级文件夹之间用 / 隔开，如：拆文/节拍表/古言（拆文 下的 节拍表 下的 古言）；留空则建在仓库根目录。"
			)
			.addText((t) =>
				t.setValue(this.plugin.settings.boardFolder).onChange(async (v) => {
					/* 防手滑：Windows 习惯输反斜杠，统一转成正斜杠再存 */
					this.plugin.settings.boardFolder = v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
					await this.plugin.saveSettings();
				})
			);

		/* ---------- 节拍模板（自定义，） ---------- */
		c.createEl("h3", { text: "节拍模板（自定义）" });
		c.createEl("div", {
			cls: "stc-hint",
			text:
				"自己加的节拍模板——比如「角色卡」这类模块，也能当成卡片放上案板。" +
				"「归属行」决定按节拍自动归行时落到哪一行（选「待定」就先进收卡盘）。删除模板不会动已经写好节拍的卡。",
		});
		const beatBox2 = c.createDiv({ cls: "stc-beat-list" });
		this.renderBeatTemplateList(beatBox2);

		/* ---------- 色彩编码表（可视化） ---------- */
		c.createEl("h3", { text: "色彩编码表" });
		c.createEl("div", {
			cls: "stc-hint",
			text:
				"卡片上「色」填的是这条线是谁的（人名或线索名），这里给每个名字指定颜色——它决定卡片左边那条色条。" +
				"名字是从你的案板里自动扫出来的，你不用手打。没指定的名字会自动分一个稳定颜色。",
		});
		const colorBox = c.createDiv({ cls: "stc-color-list" });
		this.renderColorList(colorBox);

		/* ---------- 显示选项 ---------- */
		new Setting(c)
			.setName("标出不完整的卡")
			.setDesc(
				"缺 ＋/－ 或 ＞＜ 的卡，右上角那个点变成桃红、悬停写明差什么。关掉后那个点只当编辑入口用（合格=墨绿）。"
			)
			.addToggle((t) =>
				t.setValue(!!this.plugin.settings.markBad).onChange(async (v) => {
					this.plugin.settings.markBad = v;
					await this.plugin.saveSettings();
					this.repaint();
				})
			);

		/* （用户要求）：「显示源」设置项随「源」功能一并移除 */

		/* （用户要求）：「卡数检查（可关）」整块设置随卡数检查功能一并移除
		   ——「每行目标卡数」「总卡数目标」两个设置项不再存在。 */

		c.createEl("h3", { text: "怎么用（3 步）" });
		const ol = c.createEl("ol");
		ol.createEl("li", {
			text: "建案板：命令面板 →「卡片式写作案板：新建案板文件」。或者随便一个 md，右键 →「用作卡片式写作案板」。",
		});
		ol.createEl("li", {
			text: "看板面：在案板文件里放一个 ```xw-card-board 代码块，切到阅读模式它就变成案板；也可以点左侧 ▦ 图标在侧栏看。",
		});
		ol.createEl("li", {
			text: "插卡：行末的「＋ 加一张」直接插一张空卡；想填内容就点卡片右上角的圆点（或双击卡片）打开索引卡。卡片右下角可以拖动改大小，每幕可以选排几列。",
		});
	}

	/* 节拍模板列表：固定节拍不可删，这里只管 settings.customBeats */
	renderBeatTemplateList(box) {
		box.empty();
		const plugin = this.plugin;
		const ACT_OPTS = ["", "第一幕", "第二幕", "第三幕", "第四幕"];
		const mkName = (parent, val) => {
			const el = parent.createEl("input", { type: "text", cls: "stc-input stc-beat-tpl-name", placeholder: "节拍名，如：角色卡" });
			el.value = val;
			return el;
		};
		const mkDesc = (parent, val) => {
			const el = parent.createEl("input", { type: "text", cls: "stc-input stc-beat-tpl-desc", placeholder: "释义（可选，填了会显示在弹窗和卡面）" });
			el.value = val;
			return el;
		};
		const mkActSel = (parent, val) => {
			const sel = parent.createEl("select", { cls: "stc-input stc-beat-tpl-act" });
			for (const a of ACT_OPTS) {
				const o = sel.createEl("option", { text: a === "" ? "待定（收卡盘）" : a });
				o.value = a;
			}
			sel.value = ACT_OPTS.indexOf(val) > -1 ? val : "";
			return sel;
		};

		const items = cleanCustomBeats(plugin.settings.customBeats);
		const saveList = async () => {
			plugin.settings.customBeats = items;
			syncCustomBeats(items);
			await plugin.saveSettings();
			plugin.repaint();
		};
		const dupName = (name, exceptIdx) => {
			if (BEATS.indexOf(name) > -1) return "固定节拍";
			for (let i = 0; i < items.length; i++) {
				if (i !== exceptIdx && items[i].name === name) return "自定义节拍";
			}
			return "";
		};

		const list = box.createDiv({ cls: "stc-color-table" });
		items.forEach((it, idx) => {
			const row = list.createDiv({ cls: "stc-color-line stc-beat-tpl-line" });
			const nameIn = mkName(row, it.name);
			const actSel = mkActSel(row, it.act);
			const descIn = mkDesc(row, it.desc);
			/* ：上下移动按钮——调自定义节拍模板的排列显示顺序（固定 15 拍不动） */
			const mkMove = (dir, label) => {
				const b = row.createEl("button", { cls: "stc-mini-btn stc-beat-tpl-move", text: label });
				b.setAttr("title", dir < 0 ? "上移一位" : "下移一位");
				b.addEventListener("click", async () => {
					const j = idx + dir;
					if (j < 0 || j >= items.length) return;
					const t = items[idx];
					items[idx] = items[j];
					items[j] = t;
					await saveList();
					this.renderBeatTemplateList(box);
				});
				return b;
			};
			mkMove(-1, "↑");
			mkMove(1, "↓");
			const del = row.createEl("button", { cls: "stc-color-del stc-beat-tpl-del", text: "删除" });
			del.setAttr("title", "删掉这个节拍模板（不影响已经写好节拍的卡）");
			nameIn.addEventListener("change", async () => {
				const nv = nameIn.value.trim();
				if (!nv) {
					nameIn.value = it.name;
					new Notice("名字不能为空。");
					return;
				}
				if (nv === it.name) return;
				const dup = dupName(nv, idx);
				if (dup) {
					nameIn.value = it.name;
					new Notice("「" + nv + "」和已有的" + dup + "重名了，换一个吧。");
					return;
				}
				it.name = nv;
				await saveList();
			});
			actSel.addEventListener("change", async () => {
				it.act = actSel.value;
				await saveList();
			});
			descIn.addEventListener("change", async () => {
				it.desc = descIn.value.trim();
				await saveList();
			});
			del.addEventListener("click", async () => {
				items.splice(idx, 1);
				await saveList();
				this.renderBeatTemplateList(box);
			});
		});

		if (!items.length) {
			box.createEl("div", { cls: "stc-hint", text: "还没有自定义节拍。想加「角色卡」这类模块卡就在下面加一条。" });
		}

		const addRow = box.createDiv({ cls: "stc-color-add stc-beat-tpl-add" });
		const nameNew = mkName(addRow, "");
		const actNew = mkActSel(addRow, "");
		const descNew = mkDesc(addRow, "");
		const bAdd = addRow.createEl("button", { text: "＋ 添加节拍模板", cls: "mod-cta stc-beat-tpl-addbtn" });
		bAdd.addEventListener("click", async () => {
			const n = nameNew.value.trim();
			if (!n) {
				new Notice("先写个节拍名。");
				return;
			}
			const dup = dupName(n, -1);
			if (dup) {
				new Notice("「" + n + "」和已有的" + dup + "重名了，换一个吧。");
				return;
			}
			items.push({ name: n, act: actNew.value, desc: descNew.value.trim() });
			await saveList();
			this.renderBeatTemplateList(box);
			new Notice("已添加节拍模板：「" + n + "」。");
		});
	}

	async renderColorList(box) {
		box.empty();
		const map = this.plugin.colorMapObj();
		const used = await this.plugin.collectColorNames();
		const names = Object.keys(map);
		for (const n of used) {
			if (names.indexOf(n) < 0) names.push(n);
		}

		if (!names.length) {
			box.createEl("div", {
				cls: "stc-hint",
				text: "还没扫到任何名字。先在下面加一条线；或先在案板里给卡片填「色」（人物名或线索名），这里就会自动列出来。",
			});
			/* （用户报）：以前这里直接 return，删光颜色后「＋ 加进色表」的添加框
			   也跟着消失，想再加都加不了。现在继续往下渲染添加框。 */
		}

		const list = box.createDiv({ cls: "stc-color-table" });
		for (const name of names) {
			const row = list.createDiv({ cls: "stc-color-line" });
			const nameIn = row.createEl("input", { type: "text", cls: "stc-input" });
			nameIn.value = name;
			const colorIn = row.createEl("input", { type: "color", cls: "stc-color-pick" });
			colorIn.value = map[name] || autoColor(name);
			const isAuto = !map[name];
			if (isAuto) row.addClass("stc-color-auto");
			const note = row.createEl("span", { cls: "stc-actmeta", text: isAuto ? "自动" : "" });
			const del = row.createEl("button", { cls: "stc-color-del", text: "删除" });
			del.setAttr(
				"title",
				isAuto
					? "把这条线删掉：案板里用这个名字的卡的「色」会一起清空"
					: "把这条线从色彩编码表里删掉，案板里用它的卡的「色」也一起清空"
			);

			colorIn.addEventListener("change", async () => {
				await this.plugin.setColor(nameIn.value.trim() || name, colorIn.value);
			});
			nameIn.addEventListener("change", async () => {
				const old = name;
				const nv = nameIn.value.trim();
				if (!nv || nv === old) {
					nameIn.value = old;
					return;
				}
				const m = this.plugin.colorMapObj();
				if (!m[old]) {
					nameIn.value = old;
					new Notice("「" + old + "」不在色表里（用的是自动色），先在右边选个颜色再改名。");
					return;
				}
				delete m[old];
				m[nv] = colorIn.value;
				await this.plugin.writeColorMap(m);
				/* 案板里用旧名字的卡也一起换掉，避免色条突然变样 */
				await this.renameColorInBoard(old, nv);
				this.renderColorList(box);
			});
			del.addEventListener("click", async () => {
				const n = nameIn.value.trim() || name;
				/* （用户报）：以前只删色表里的颜色指定，案板里用这个名字的卡的
				   「色」还在——这行名单立刻回来还变成「自动」，再点删除又提示
				   没东西可删，看起来就是"删不掉"。现在单击一次删干净：色表指定 +
				   案板卡片的「色」字段一起清；删错了重新加一条就行。 */
				const hit = await this.plugin.removeColorName(n);
				/* ：clearColorInBoard 是本类（设置页）的方法，不在 plugin 上——以前写成
				   this.plugin.clearColorInBoard 会抛 "not a function"，后面的重绘永远
				   执行不到：色表条目删掉了，但屏幕上那一行不消失，非要等下次加颜色
				   触发的重绘才消失。 */
				const cleared = await this.clearColorInBoard(n);
				if (!hit && !cleared) {
					new Notice("「" + n + "」色表里没有指定颜色，案板里也没有卡在用这个名字，没东西可删。");
					return;
				}
				new Notice("已删掉「" + n + "」" + (hit ? "（色表指定）" : "") + (cleared ? "（案板里用这个名字的卡的「色」已一并清空）" : "") + "。");
				this.renderColorList(box);
			});
		}

		const addRow = box.createDiv({ cls: "stc-color-add" });
		const nameNew = addRow.createEl("input", { type: "text", cls: "stc-input" });
		nameNew.placeholder = "新增一条线：人名 / 线索名";
		const colorNew = addRow.createEl("input", { type: "color", cls: "stc-color-pick" });
		colorNew.value = PALETTE[names.length % PALETTE.length];
		const bAdd = addRow.createEl("button", { text: "＋ 加进色表", cls: "mod-cta" });
		bAdd.addEventListener("click", async () => {
			const n = nameNew.value.trim();
			if (!n) {
				new Notice("先写个名字。");
				return;
			}
			await this.plugin.setColor(n, colorNew.value);
			this.renderColorList(box);
		});

		box.createEl("div", {
			cls: "stc-hint",
			text: "'自动' = 这个名字没在色表里，插件按名字算了个稳定颜色。想固定下来就点右边的色块挑一个。",
		});
	}

	/* 色表里改名后，把案板里用旧名字的卡一起改掉 */
	async renameColorInBoard(oldName, newName) {
		try {
			const f = this.plugin.getBoardFile();
			if (!f) return;
			const raw = await this.plugin.app.vault.read(f);
			const b = boardFromRaw(raw);
			let hit = 0;
			for (const c of b.cards) {
				if (String(c.get(K.color)).trim() === oldName) {
					c.set(K.color, newName);
					hit++;
				}
			}
			if (!hit) return;
			const sp = splitMarks(raw);
			const body = b.cards.map((c, i) => serializeCard(c, cardNoOf(b.cards, i))).join("\n\n");
			const metaBlock = hasMetaInFile(raw) ? serializeMeta(b.meta) + "\n\n" : "";
			const out = sp.head + START_MARK + "\n\n" + metaBlock + body + (body ? "\n\n" : "") + END_MARK + sp.tail;
			this.plugin.writing = true;
			await this.plugin.app.vault.modify(f, out);
			window.setTimeout(() => {
				this.plugin.writing = false;
			}, 400);
			new Notice("案板里有 " + hit + " 张卡的「色」跟着改了名。");
		} catch (e) {
			/* 改不动也不影响色表本身 */
		}
	}

	/* 色表里删掉一条线后，把案板里用这个名字的卡的「色」字段整个清掉，
	   否则名单是从案板扫出来的，这行会立刻回来还变成「自动」（用户报的"删不掉"）。返回清掉几张。
	   注意：先清**当前打开的案板视图**（内存卡＋它自己的文件）——设置里指向的
	   boardFile 可能已改名/不存在，只清它会出现"怎么删都删不掉"的假象。 */
	async clearColorInBoard(name) {
		const n = String(name || "").trim();
		if (!n) return 0;
		let hit = 0;
		const seen = {};
		const clearFile = async (f) => {
			if (!f || seen[f.path]) return;
			seen[f.path] = true;
			try {
				const raw = await this.plugin.app.vault.read(f);
				const b = boardFromRaw(raw);
				let h = 0;
				for (const c of b.cards) {
					if (String(c.get(K.color)).trim() === n) {
						c.fields = c.fields.filter((x) => x.k !== K.color);
						h++;
					}
				}
				if (!h) return;
				const sp = splitMarks(raw);
				const body = b.cards.map((c, i) => serializeCard(c, cardNoOf(b.cards, i))).join("\n\n");
				const metaBlock = hasMetaInFile(raw) ? serializeMeta(b.meta) + "\n\n" : "";
				const out = sp.head + START_MARK + "\n\n" + metaBlock + body + (body ? "\n\n" : "") + END_MARK + sp.tail;
				this.plugin.writing = true;
				await this.plugin.app.vault.modify(f, out);
				window.setTimeout(() => {
					this.plugin.writing = false;
				}, 400);
				hit += h;
			} catch (e) {
				/* 改不动也不影响色表本身 */
			}
		};
		/* 当前打开的案板视图优先——名单就是从它扫出来的；
		   设置里指向的 boardFile 可能已改名/不存在，只清它会出现"怎么删都删不掉"的假象。
		   ⚠️ BoardView 上没有 file()！文件挂在 view.engine 上（engine.file()），
		   以前这里判断 v.file 恒为假，整段清卡逻辑是死的。 */
		const v = this.plugin.view();
		const eng = v && v.engine;
		/* ① 先清视图**内存里**的卡：即使后面写文件失败，本次重绘也能立刻看不到这个名字 */
		if (eng && Array.isArray(eng.cards)) {
			for (const c of eng.cards) {
				if (String(c.get(K.color)).trim() === n) {
					c.fields = c.fields.filter((x) => x.k !== K.color);
					hit++;
				}
			}
		}
		/* ② 把视图正在用的那份文件写回 */
		if (eng && typeof eng.file === "function") await clearFile(eng.file());
		/* ③ 兜底：设置里指向的案板文件（可能不是当前打开的这份） */
		await clearFile(this.plugin.getBoardFile());
		/* ④ 正在显示的这份被改了，让它重读一遍，色条跟着消失 */
		if (hit && v && typeof v.reload === "function") {
			try {
				await v.reload();
			} catch (e) {
				/* 重读失败不影响色表本身 */
			}
		}
		return hit;
	}

	repaint() {
		const v = this.plugin.view();
		if (v) v.render();
	}
}

/* ---------------------------------------------------------------- 命令：新建案板时也给内嵌视图用 */

module.exports = SaveTheCatBoardPlugin;
module.exports.default = SaveTheCatBoardPlugin;

/* 供离线自测使用（不影响 Obsidian 运行） */
module.exports.__internals = {
	Card: Card,
	BoardMeta: BoardMeta,
	BoardEngine: BoardEngine,
	BoardView: BoardView,
	CardModal: CardModal,
	TextPromptModal: TextPromptModal,
	AddActModal: AddActModal,
	BoardFileModal: BoardFileModal,
	BoardSettingTab: BoardSettingTab,
	SelfCheckModal: SelfCheckModal,
	SummaryModal: SummaryModal,
	summarizeCards: summarizeCards,
	cardNoOf: cardNoOf,
	buildNoMap: buildNoMap,
	isPrologueCard: isPrologueCard,
	dropMode: dropMode,
	BRUSH_SVG: BRUSH_SVG,
	BEATS: BEATS,
	ACT_KEYS: ACT_KEYS,
	HINGE: HINGE,
	syncCustomBeats: syncCustomBeats,
	customBeatNames: customBeatNames,
	beatActOf: beatActOf,
	cleanCustomBeats: cleanCustomBeats,
	migrateLegacyActs: migrateLegacyActs,
	parseCards: parseCards,
	cardsFromRaw: cardsFromRaw,
	boardFromRaw: boardFromRaw,
	serializeCard: serializeCard,
	serializeMeta: serializeMeta,
	parseMeta: parseMeta,
	hasMetaInFile: hasMetaInFile,
	splitMarks: splitMarks,
	computeStats: computeStats,
	validate: validate,
	checkCard: checkCard,
	isParagraphCard: isParagraphCard,
	countArrows: countArrows,
	pmLead: pmLead,
	pmParts: pmParts,
	pmText: pmText,
	cfParts: cfParts,
	cfText: cfText,
	autoColor: autoColor,
	normAct: normAct,
	normBeat: normBeat,
	beatDesc: beatDesc,
	BEAT_DESC: BEAT_DESC,
	newBoardTemplate: newBoardTemplate,
	beatAnchorCards: beatAnchorCards,
	cloneBoardLayout: cloneBoardLayout,
	START_MARK: START_MARK,
	END_MARK: END_MARK,
	BEATS: BEATS,
	ACTS: ACTS,
	HINGE: HINGE,
	PALETTE: PALETTE,
	DEFAULT_SETTINGS: DEFAULT_SETTINGS,
	MAX_COLS: MAX_COLS,
	DEFAULT_W: DEFAULT_W,
	DEFAULT_H: DEFAULT_H,
	MIN_W: MIN_W,
	MIN_H: MIN_H,
};
