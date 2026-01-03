async function initAuth() {
    const auth = firebase.auth();

    // 既にログイン済みならそれを返す（匿名/Google/Apple いずれでもOK）
    if (auth.currentUser) return auth.currentUser;

    // onAuthStateChanged は非同期なので、最初のユーザー確定を待つ
    const user = await new Promise((resolve, reject) => {
        const unsub = auth.onAuthStateChanged(
            async (u) => {
                try {
                    unsub();
                    if (u) return resolve(u);

                    // 未ログインなら匿名でサインイン
                    await auth.signInAnonymously();
                    resolve(auth.currentUser);
                } catch (e) {
                    reject(e);
                }
            },
            (e) => reject(e)
        );
    });

    // 既存コード互換: window.currentUid を残す
    window.currentUid = user.uid;
    console.log(
        "✅ Firebase Auth ready. uid=",
        user.uid,
        "isAnonymous=",
        user.isAnonymous
    );

    return user;
    currentUser = user;
}

async function upgradeToGoogle() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("not signed in");

    const provider = new firebase.auth.GoogleAuthProvider();

    // LIFF/モバイルWebView では popup がブロックされることがあるので fallback も用意
    try {
        await user.linkWithPopup(provider);
    } catch (e) {
        console.warn("linkWithPopup failed; fallback to redirect", e);
        await user.linkWithRedirect(provider);
    }
}

async function upgradeToApple() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("Not signed in");

    const provider = new firebase.auth.OAuthProvider("apple.com");
    provider.addScope("email");
    provider.addScope("name");

    await user.linkWithPopup(provider); // 昇格（uid維持）
    alert("Apple連携が完了しました");
}

// ===== ここを自分の値に書き換える（1）: LIFF ID =====
const LIFF_ID = "2008513371-Xr0AYLvA";

// ===== グローバル変数 =====
let db = null; // Firestore
let currentEventId = null; // 選択中イベントID
let currentEventData = null; // 現在表示中のイベントデータ
let lineupCandidates = []; // 出席（◎/〇）メンバー一覧
let lineupStarting = []; // 保存済みスタメン
let currentUser = null; // firebase.auth().currentUser
let currentUserRole = "member";
let joinRequestWatcherUnsub = null;


// ===== 追加：teamId（URLで切り替え可能）=====
// ===== チーム選択（URL ?teamId=... / localStorage）=====
let TEAM_ID =
    new URLSearchParams(location.search).get("teamId") ||
    localStorage.getItem("teamId") ||
    "";

function getTeamId() {
    // TEAM_ID がソースオブトゥルース
    return (TEAM_ID || localStorage.getItem("teamId") || "").trim();
}

// setTeamId の最後にこれも追加しておくと安心
function setTeamId(teamId, { pushUrl = true, save = true } = {}) {
    TEAM_ID = (teamId || "").trim();
    window.currentTeamId = TEAM_ID; // ★追加（古い参照互換）

    if (save) {
        if (TEAM_ID) localStorage.setItem("teamId", TEAM_ID);
        else localStorage.removeItem("teamId");
    }
    if (pushUrl) {
        const url = new URL(location.href);
        if (TEAM_ID) url.searchParams.set("teamId", TEAM_ID);
        else url.searchParams.delete("teamId");
        history.replaceState(null, "", url.toString());
    }
}

const col = {
    teams: () => db.collection("teams"),

    // teamId を省略したら現在の TEAM_ID を使う
    team: (teamId = getTeamId()) => {
        const tid = (teamId || "").trim();
        if (!tid)
            throw new Error(
                "teamId is empty (TEAM_ID / URL / localStorage を確認)"
            );
        return col.teams().doc(tid);
    },

    // --- members ---
    members: (teamId = getTeamId()) => col.team(teamId).collection("members"),

    // (teamId, uid) でも (uid) でも動くように吸収
    member: (a, b) => {
        if (b === undefined) {
            const uid = (a || "").trim();
            return col.members(getTeamId()).doc(uid);
        }
        const teamId = (a || "").trim();
        const uid = (b || "").trim();
        return col.members(teamId).doc(uid);
    },

    // --- events ---
    events: (teamId = getTeamId()) => col.team(teamId).collection("events"),

    // (teamId, eventId) でも (eventId) でもOK
    event: (a, b) => {
        if (b === undefined) {
            const eventId = (a || "").trim();
            return col.events(getTeamId()).doc(eventId);
        }
        const teamId = (a || "").trim();
        const eventId = (b || "").trim();
        return col.events(teamId).doc(eventId);
    },

    // --- responses ---
    // (teamId, eventId) でも (eventId) でもOK
    responses: (a, b) => {
        if (b === undefined) {
            const eventId = (a || "").trim();
            return col.event(eventId).collection("responses");
        }
        const teamId = (a || "").trim();
        const eventId = (b || "").trim();
        return col.event(teamId, eventId).collection("responses");
    },

    // (teamId, eventId, uid) でも (eventId, uid) でもOK
    response: (a, b, c) => {
        if (c === undefined) {
            const eventId = (a || "").trim();
            const uid = (b || "").trim();
            return col.responses(eventId).doc(uid);
        }
        const teamId = (a || "").trim();
        const eventId = (b || "").trim();
        const uid = (c || "").trim();
        return col.responses(teamId, eventId).doc(uid);
    },

    // --- memos ---
    memos: (teamId = getTeamId()) => col.team(teamId).collection("memos"),
    memo: (a, b) => {
        if (b === undefined) {
            const memoId = (a || "").trim();
            return col.memos(getTeamId()).doc(memoId);
        }
        const teamId = (a || "").trim();
        const memoId = (b || "").trim();
        return col.memos(teamId).doc(memoId);
    },

    // --- invites / joinRequests（将来用）---
    invites: (teamId = getTeamId()) => col.team(teamId).collection("invites"),
    invite: (teamId, inviteId) => col.invites(teamId).doc(inviteId),

    joinRequests: (teamId = getTeamId()) =>
        col.team(teamId).collection("joinRequests"),
    joinRequest: (teamId, requestId) => col.joinRequests(teamId).doc(requestId),
};

const TS = firebase.firestore.FieldValue.serverTimestamp;

// LIFF（任意）：表示名取得に使う（Firebase Auth の uid とは別）
let liffProfile = null; // { userId, displayName }

// 助っ人用の固定ID＆表示名
const GUEST_MEMBER_ID = "guest-player"; // なんでもOK。被らないIDにする
const GUEST_MEMBER_NAME = "助っ人";

// HTMLエスケープ（XSS対策）
function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function isPermissionDenied(error) {
    const code = error?.code || "";
    const message = error?.message || "";
    return (
        code === "permission-denied" ||
        message.includes("Missing or insufficient permissions")
    );
}

// Backward-compatible alias to avoid ReferenceError in older call sites.
const isPermissionDeniedError = isPermissionDenied;

/**
 * 画面の「ログイン/連携」UI を初期化
 * - 初回は匿名ログイン（signInAnonymously）
 * - 「Google連携」で同じユーザー(uid)にGoogleを link する（データ引継ぎ）
 * - Apple は後回し（コードだけ置いておく）
 */
function bindAuthUI() {
    const statusEl = document.getElementById("auth-status");
    const googleBtn = document.getElementById("auth-google-link-btn");
    const nameBtn = document.getElementById("auth-edit-name-btn");

    const refresh = () => {
        const u = firebase.auth().currentUser;
        if (!statusEl) return;

        if (!u) {
            statusEl.textContent = "未ログイン";
            return;
        }

        statusEl.textContent = u.isAnonymous
            ? `匿名ログイン中（uid: ${u.uid.slice(0, 6)}...）`
            : `ログイン中（${u.providerData?.[0]?.providerId || "linked"}）`;
    };

    if (googleBtn) {
        googleBtn.addEventListener("click", async () => {
            try {
                googleBtn.disabled = true;
                await upgradeToGoogle();
                // Google連携後、displayName が入ることがあるので currentUser を更新
                const u = firebase.auth().currentUser;
                if (u)
                    currentUser = {
                        uid: u.uid,
                        displayName:
                            u.displayName || currentUser?.displayName || "",
                    };
                if (TEAM_ID) {
                    await ensureMember(
                        TEAM_ID,
                        currentUser.uid,
                        currentUser.displayName || "ゲスト",
                        "member"
                    );
                }
                refresh();
                alert(
                    "✅ Google連携が完了しました（データは同じuidに引き継がれます）"
                );
            } catch (e) {
                console.error(e);
                alert(
                    "Google連携に失敗しました。コンソールを確認してください。"
                );
            } finally {
                googleBtn.disabled = false;
            }
        });
    }

    if (nameBtn) {
        nameBtn.addEventListener("click", async () => {
            const u = firebase.auth().currentUser;
            if (!u) return alert("ログイン情報を取得できませんでした。");
            const name = prompt(
                "表示名（ニックネーム）を入力してください",
                currentUser?.displayName || ""
            );
            if (!name) return;
            currentUser = { uid: u.uid, displayName: name };
            await col
                .members()
                .doc(u.uid)
                .set({ displayName: name, updatedAt: TS() }, { merge: true });
            refresh();
            alert("✅ 表示名を更新しました");
        });
    }

    // 認証状態変化で表示更新
    firebase.auth().onAuthStateChanged(() => refresh());
    refresh();
}

// 日時表示用（Firestore Timestamp → "MM/DD HH:MM"）
function formatDateTime(ts) {
    try {
        const d = ts.toDate(); // Firestore Timestamp → Date
        return d.toLocaleString("ja-JP", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch (e) {
        return "";
    }
}

// 日付表示用（Date → "YYYY-MM-DD"）
function formatDate(d) {
    if (!(d instanceof Date)) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// "YYYY-MM-DD"（または "YYYY-MM-DD(○)"）から「YYYY-MM-DD(日)」のような表示文字列を返す
function formatDateWithWeekdayString(dateStr) {
    if (!dateStr) return "";
    // 先頭10文字だけを「年月日」として扱う（古いデータで "(日)" などが付いていてもOKにする）
    const base = dateStr.slice(0, 10);
    const parts = base.split("-");
    if (parts.length !== 3) return dateStr;

    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (!y || !m || !d) return dateStr;

    const dateObj = new Date(y, m - 1, d);
    if (isNaN(dateObj.getTime())) return dateStr;

    const weekdayMap = "日月火水木金土";
    const w = weekdayMap[dateObj.getDay()];

    const mm = String(m).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    return `${y}-${mm}-${dd}(${w})`;
}

// 管理者の LINE userId
// ★ 追加：現在のユーザーが管理者かどうか（下の role 版を使用）
// 出席扱いにするステータス
const ATTEND_OK_STATUSES = ["present", "late"];

// ========== URL から eventId を取得 ==========
function getEventIdFromUrl() {
    const params = new URLSearchParams(window.location.search);

    // ① ?eventId=... で開いた場合
    const direct = params.get("eventId");
    if (direct && direct.trim() !== "") {
        console.log("URL から eventId を取得（direct）:", direct);
        return direct.trim();
    }

    // ② LIFF の deep link (?liff.state=/eventId=...) の場合
    const liffState = params.get("liff.state");
    if (liffState) {
        const innerParams = new URLSearchParams(liffState);
        const fromLiff = innerParams.get("eventId");
        if (fromLiff && fromLiff.trim() !== "") {
            console.log("URL から eventId を取得（liff.state）:", fromLiff);
            return fromLiff.trim();
        }
    }

    console.log("eventId が見つからないので 一覧モード で表示");
    return null;
}

// ========== ステータス → 表示ラベル ==========
function convertStatusToLabel(status) {
    switch (status) {
        case "present":
            return { label: "◎ 出席", color: "green" };
        case "late":
            return { label: "〇 遅刻", color: "orange" };
        case "undecided":
            return { label: "△ 未定", color: "blue" };
        case "absent":
            return { label: "✖ 欠席", color: "red" };
        case "no_response":
        default:
            return { label: "未回答", color: "gray" };
    }
}

// ========== イベント種別 → 表示ラベル ==========
function convertEventTypeLabel(type) {
    switch (type) {
        case "official":
            return "公式戦";
        case "practiceGame":
            return "練習試合";
        case "practice":
            return "練習";
        case "other":
            return "その他イベント";
        default:
            return "";
    }
}

// ========== 単一イベント保存・汎用保存 ==========
async function saveResponseFor(eventId, uid, status, comment = "") {
    const responseRef = col.response(eventId, uid);
    await db.collection("teams").doc(teamId)
        .collection("members").doc(uid)
        .set({
            uid,                       // ✅必須
            displayName: displayName || "",
            role: role || "member",
            isActive: true,            // ✅クエリで使ってるので必須
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
}


// 詳細画面用（currentEventId を使う）
async function saveAttendance(status) {
    if (!currentEventId) {
        alert("イベントが選択されていません");
        return;
    }
    if (!currentUser) {
        alert("ログイン情報が取得できていません");
        return;
    }
    await saveResponseFor(currentEventId, currentUser.uid, status, "");
}

// ========== 自分の出欠を一覧表示 ==========
async function loadMyAttendance() {
    const container = document.getElementById("my-attendance-table");
    if (!container) return;
    if (!currentUser) {
        container.textContent = "ログインしてください";
        return;
    }

    container.textContent = "読み込み中...";

    const eventsSnap = await col
        .events()
        .orderBy("date", "desc")
        .limit(20)
        .get();

    const myRespSnap = await db
        .collectionGroup("responses")
        .where("teamId", "==", TEAM_ID)
        .where("uid", "==", currentUser.uid)
        .get();

    const respByEvent = {};
    myRespSnap.forEach((doc) => {
        const d = doc.data() || {};
        if (d.eventId) respByEvent[d.eventId] = d;
    });

    container.innerHTML = "";
    eventsSnap.forEach((doc) => {
        const event = { id: doc.id, ...(doc.data() || {}) };
        const my = respByEvent[event.id] || {};
        const current = my.status || "unknown";

        const row = document.createElement("div");
        row.className = "my-attendance-row";
        row.innerHTML = `
      <div class="event-title">${escapeHtml(event.title || "")}</div>
      <div class="event-meta">${escapeHtml(event.date || "")} ${escapeHtml(
            event.time || ""
        )} / ${escapeHtml(event.place || "")}</div>
      <div class="event-actions">
        <button class="att-btn" data-status="present">参加</button>
        <button class="att-btn" data-status="late">遅刻</button>
        <button class="att-btn" data-status="absent">欠席</button>
        <span class="current-status">現在: ${escapeHtml(current)}</span>
      </div>
    `;

        row.querySelectorAll(".att-btn").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const status = btn.dataset.status;
                await saveResponseFor(event.id, currentUser.uid, status, "");
                await loadMyAttendance();
            });
        });

        container.appendChild(row);
    });
}

// ========== LIFF 初期化 & ユーザー情報取得 ==========
async function initLiffOptional() {
    // LINEの外（通常ブラウザ）でも動かすため、liff が無ければスキップ
    if (typeof window.liff === "undefined") {
        console.log("LIFF SDK が未ロードのためスキップ");
        return null;
    }

    try {
        await liff.init({ liffId: LIFF_ID });

        if (!liff.isLoggedIn()) {
            // LINE内で使う想定なら login。外部ブラウザでは何もしないでもOK
            // ※必要ならコメントアウトしてください
            // liff.login();
            console.log(
                "LIFF未ログイン（必要に応じて liff.login() を実行してください）"
            );
            return null;
        }

        liffProfile = await liff.getProfile();
        console.log("LIFF profile:", liffProfile);
        return liffProfile;
    } catch (e) {
        console.warn("initLiffOptional failed", e);
        return null;
    }
}

// ========== members 登録 ==========
async function ensureMember(teamId, uid, displayName, role) {
    if (!teamId || !uid) return;

    const memberRef = col.member(teamId, uid);
    const now = TS();

    // 既に member doc がある場合は、最低限のフィールドだけ補完（uid など）
    const snap = await memberRef.get();
    if (snap.exists) {
        const data = snap.data() || {};
        const patch = {};
        if (!data.uid) patch.uid = uid;
        if (!data.displayName && displayName) patch.displayName = displayName;
        if (data.isActive !== true) patch.isActive = true;
        patch.updatedAt = now;

        if (Object.keys(patch).length > 0) {
            await memberRef.set(patch, { merge: true });
        }
        return;
    }

    // 無ければ新規作成
    await memberRef.set(
        {
            uid,
            displayName: displayName || "ゲスト",
            isActive: true,
            joinedAt: now,
            role: role || "member",
            updatedAt: now,
        },
        { merge: false }
    );
}

function isCurrentUserAdmin() {
    return ["owner", "admin"].includes(currentUserRole || "member");
}

// イベント一覧の読み込み
async function loadEventList() {
    const list = document.getElementById("event-list");
    if (!list) return;
    list.textContent = "読み込み中...";

    const snap = await col.events().orderBy("date", "desc").limit(50).get();
    list.innerHTML = "";
    snap.forEach((doc) => {
        const data = doc.data() || {};
        const item = document.createElement("div");
        item.className = "event-item";
        item.textContent = `${data.date || ""} ${data.time || ""} ${data.title || ""
            } @${data.place || ""}`;
        item.onclick = async () => {
            currentEventId = doc.id;
            await loadAttendanceList();
        };
        list.appendChild(item);
    });
}

// 一覧 ←→ 詳細 の戻るボタン
function setupBackButton() {
    const backBtn = document.getElementById("back-to-list-btn");
    if (!backBtn) return;

    backBtn.addEventListener("click", () => {
        location.search = ""; // クエリを消して再読み込み → 一覧モード
    });
}

// ========== 特定イベントの情報読み込み ==========
async function loadEvent() {
    console.log("loadEvent currentEventId:", currentEventId);

    const eventRef = col.events().doc(currentEventId);
    const snap = await eventRef.get();
    const eventDiv = document.getElementById("event-info");

    if (!snap.exists) {
        eventDiv.innerHTML = `
      <p>イベントID「${currentEventId}」のデータが Firestore にありません。</p>
      <p>Cloud Firestore の <code>events</code> コレクションに
      同じ ID のドキュメントを作成してください。</p>`;
        return;
    }

    const data = snap.data();
    currentEventData = { id: currentEventId, ...data }; // ★ ここで保持

    const typeLabel = convertEventTypeLabel(data.type);
    const displayDate = formatDateWithWeekdayString(data.date || "");

    eventDiv.innerHTML = `
<p><strong>試合名：</strong>${escapeHtml(data.title || "")}</p>
<p><strong>日時：</strong>${escapeHtml(displayDate)} ${escapeHtml(
        data.time || ""
    )}</p>
    <p><strong>場所：</strong>${escapeHtml(data.place || "")}</p>
    ${typeLabel ? `<p><strong>種別：</strong>${escapeHtml(typeLabel)}</p>` : ""}
    <p><strong>メモ：</strong>${escapeHtml(data.note || "")}</p>`;

    // ★ 種別に応じてオーダーエリアを表示
    await setupLineupSectionIfNeeded();
}

// ========== 出欠一覧 ==========
async function loadAttendanceList() {
    const list = document.getElementById("attendance-list");
    const titleEl = document.getElementById("attendance-event-title"); // (任意: HTMLに無ければnull)
    if (!list) return;

    if (!currentEventId) {
        list.textContent = "イベントを選択してください";
        return;
    }

    list.textContent = "読み込み中...";

    const [membersSnap, eventSnap, responsesSnap] = await Promise.all([
        col.members().get(),
        col.event(currentEventId).get(),
        col.responses(currentEventId).get(),
    ]);

    const eventData = eventSnap.data() || {};
    if (titleEl) {
        if (titleEl)
            titleEl.textContent = `${eventData.date || ""} ${eventData.time || ""
                } ${eventData.title || ""}`;
    }

    const respMap = {};
    responsesSnap.forEach((doc) => {
        respMap[doc.id] = doc.data() || {};
    });

    list.innerHTML = "";
    membersSnap.forEach((m) => {
        const uid = m.id;
        const member = m.data() || {};
        const resp = respMap[uid] || {};
        const status = resp.status || "unknown";
        const comment = resp.comment || "";

        const row = document.createElement("div");
        row.className = "attendance-row";
        row.innerHTML = `
      <div class="att-name">${escapeHtml(member.displayName || uid)}</div>
      <select class="att-status">
        <option value="unknown">未回答</option>
        <option value="present">参加</option>
        <option value="late">遅刻</option>
        <option value="absent">欠席</option>
      </select>
      <input class="att-comment" placeholder="コメント" value="${escapeHtml(
            comment
        )}" />
      <button class="att-save">保存</button>
    `;

        const sel = row.querySelector(".att-status");
        sel.value = status;

        row.querySelector(".att-save").addEventListener("click", async () => {
            const newStatus = sel.value;
            const newComment = row.querySelector(".att-comment").value.trim();
            await saveResponseFor(currentEventId, uid, newStatus, newComment);
            await loadAttendanceList();
        });

        list.appendChild(row);
    });
}

// ========== オーダー（ラインナップ） ==========

// 種別が 公式戦 or 練習試合 のときだけオーダーを表示
async function setupLineupSectionIfNeeded() {
    const block = document.getElementById("lineup-block");
    const editor = document.getElementById("lineup-editor");
    const saveBtn = document.getElementById("lineup-save-btn");
    if (!block || !editor) return;

    if (!currentEventData) {
        block.style.display = "none";
        return;
    }

    const type = currentEventData.type || "";
    const isGame = type === "official" || type === "practiceGame";
    if (!isGame) {
        block.style.display = "none";
        return;
    }

    const isAdmin = isCurrentUserAdmin();
    const lineup = currentEventData.lineup || {};
    const isPublished = !!lineup.isPublished;

    // ★ 管理者以外 & 非公開 → そもそも表示しない
    if (!isAdmin && !isPublished) {
        block.style.display = "none";
        return;
    }

    block.style.display = "block";

    // ボタンは管理者以外には非表示
    if (saveBtn) {
        saveBtn.style.display = isAdmin ? "inline-block" : "none";
    }

    editor.textContent = "読み込み中…";

    if (isAdmin) {
        // 管理者：編集用フォーム
        await loadLineupEditor();
        if (saveBtn && !saveBtn.dataset.listenerAdded) {
            saveBtn.addEventListener("click", saveLineup);
            saveBtn.dataset.listenerAdded = "1";
        }
    } else {
        // 一般メンバー：閲覧専用
        await loadLineupReadonly();
    }
}

// 出席（◎/〇）メンバーを候補として読み込み & 行を描画（管理者用）
async function loadLineupEditor() {
    const editor = document.getElementById("lineup-editor");
    if (!editor) return;

    try {
        const [membersSnap, responsesSnap] = await Promise.all([
            col.members().get(),
            col
                .responses(currentEventId)
                .where("status", "in", ["present", "late"])
                .get(),
        ]);

        const membersMap = {};
        membersSnap.forEach((doc) => {
            const m = doc.data();
            membersMap[doc.id] = m.displayName || "名前未設定";
        });

        const statusMap = {};
        responsesSnap.forEach((doc) => {
            const a = doc.data();
            statusMap[a.uid || doc.id] = a.status;
        });

        // ◎ or 〇 のメンバーだけ候補にする
        lineupCandidates = Object.keys(statusMap)
            .filter((uid) => ATTEND_OK_STATUSES.includes(statusMap[uid]))
            .map((uid) => ({
                id: uid,
                name: membersMap[uid] || "名前未設定",
            }));

        lineupCandidates.sort((a, b) => a.name.localeCompare(b.name, "ja-JP"));

        // ★ 助っ人を常に候補に追加（出欠に関係なく）
        lineupCandidates.push({
            id: GUEST_MEMBER_ID,
            name: GUEST_MEMBER_NAME,
        });

        const lineup = (currentEventData && currentEventData.lineup) || {};

        lineupStarting = Array.isArray(lineup.starting) ? lineup.starting : [];
        const system = lineup.system || "NORMAL9";
        const memo = lineup.memo || "";
        const isPublished = !!lineup.isPublished;

        if (lineupCandidates.length === 0) {
            editor.innerHTML =
                "<p>出席（◎）または遅刻（〇）のメンバーがいません。<br>まず出欠を登録してください。</p>";
            return;
        }

        editor.innerHTML = `
        <div class="lineup-system-row">
          <label>打順人数
            <select id="lineup-system-select">
              <option value="NORMAL9"${system === "NORMAL9" ? " selected" : ""
            }>9人制</option>
              <option value="DH10"${system === "DH10" ? " selected" : ""
            }>DH制（10人打ち）</option>
              <option value="DH11"${system === "DH11" ? " selected" : ""
            }>DH制（11人打ち）</option>
              <option value="DH12"${system === "DH12" ? " selected" : ""
            }>DH制（12人打ち）</option>
              <option value="DH13"${system === "DH13" ? " selected" : ""
            }>DH制（13人打ち）</option>
              <option value="DH14"${system === "DH14" ? " selected" : ""
            }>DH制（14人打ち）</option>
              <option value="DH15"${system === "DH15" ? " selected" : ""
            }>DH制（15人打ち）</option>
            </select>
          </label>
        </div>

        <div class="lineup-publish-row">
          <label>
            <input type="checkbox" id="lineup-publish-checkbox"${isPublished ? " checked" : ""
            }>
            オーダーをメンバーに公開する
          </label>
        </div>

        <div id="lineup-rows-container"></div>

        <div class="lineup-memo-row">
          <label>メモ（継投・守備変更など）
            <textarea id="lineup-memo" rows="2"
              placeholder="例: 永久ベンチ→中橋、三振したら#21交代">${escapeHtml(
                memo
            )}</textarea>
          </label>
        </div>
      `;

        const systemSelect = document.getElementById("lineup-system-select");
        const rerender = () => renderLineupRows(systemSelect.value);
        systemSelect.addEventListener("change", rerender);
        rerender();
    } catch (e) {
        console.error("loadLineupEditor error:", e);
        editor.textContent =
            "オーダー情報の読み込みに失敗しました。時間をおいて再度お試しください。";
    }
}

// system に応じて 1〜9 or 10〜15 行の打順フォームを描画
function renderLineupRows(system) {
    const container = document.getElementById("lineup-rows-container");
    if (!container) return;

    // ★ system から最大打順を決める
    //   NORMAL9 → 9
    //   DH10〜DH15 → 10〜15
    let maxOrder = 9;
    if (system && system.startsWith("DH")) {
        const num = Number(system.replace("DH", ""));
        maxOrder = isNaN(num) ? 10 : num; // 想定外の値ならとりあえず10
    }

    // ★ 守備に「ベンチ」を追加
    const positions = [
        "投",
        "捕",
        "一",
        "二",
        "三",
        "遊",
        "左",
        "中",
        "右",
        "DH",
        "ベンチ",
    ];

    let html =
        '<table class="lineup-table"><thead><tr><th>打順</th><th>名前</th><th>守備</th></tr></thead><tbody>';

    for (let order = 1; order <= maxOrder; order++) {
        const existing = lineupStarting.find((p) => p.order === order) || {};
        const selectedMemberId = existing.memberId || "";
        // ★ デフォルト守備は空。必要に応じて「DH」や「ベンチ」を手動で選択
        const selectedPos = existing.position || "";

        html += `<tr class="lineup-row" data-order="${order}">`;
        html += `<td>${order}</td>`;

        // 名前 select
        html += `<td><select class="lineup-player-select">`;
        html += `<option value="">（選手を選択）</option>`;
        lineupCandidates.forEach((m) => {
            html += `<option value="${m.id}"${m.id === selectedMemberId ? " selected" : ""
                }>${escapeHtml(m.name)}</option>`;
        });
        html += `</select></td>`;

        // 守備 select
        html += `<td><select class="lineup-pos-select">`;
        html += `<option value="">ー</option>`;
        positions.forEach((pos) => {
            html += `<option value="${pos}"${pos === selectedPos ? " selected" : ""
                }>${pos}</option>`;
        });
        html += `</select></td>`;

        html += `</tr>`;
    }

    html += "</tbody></table>";
    container.innerHTML = html;
}

// 一般メンバー向け：閲覧専用のオーダー表示
async function loadLineupReadonly() {
    const editor = document.getElementById("lineup-editor");
    if (!editor) return;

    const lineup = (currentEventData && currentEventData.lineup) || {};
    const starting = Array.isArray(lineup.starting) ? [...lineup.starting] : [];

    if (!starting.length) {
        editor.innerHTML = "<p>まだオーダーが登録されていません。</p>";
        return;
    }

    // 打順順にソート
    starting.sort((a, b) => (a.order || 0) - (b.order || 0));

    // メンバー名取得
    const membersSnap = await col.members().get();
    const nameMap = {};
    membersSnap.forEach((doc) => {
        const m = doc.data();
        nameMap[doc.id] = m.displayName || "名前未設定";
    });

    let html =
        '<table class="lineup-table"><thead><tr><th>打順</th><th>名前</th><th>守備</th></tr></thead><tbody>';

    starting.forEach((p) => {
        const name = nameMap[p.memberId] || "";
        html += `<tr><td>${p.order}</td><td>${escapeHtml(
            name
        )}</td><td>${escapeHtml(p.position || "")}</td></tr>`;
    });

    html += "</tbody></table>";

    if (lineup.memo) {
        html += `<div class="lineup-memo-display">
          <strong>メモ：</strong>${escapeHtml(lineup.memo)}
        </div>`;
    }

    editor.innerHTML = html;
}

// 保存ボタン押下時の処理（管理者のみ）
async function saveLineup() {
    if (!isCurrentUserAdmin()) {
        alert("オーダーを編集できるのは管理者のみです。");
        return;
    }

    const block = document.getElementById("lineup-block");
    const systemSelect = document.getElementById("lineup-system-select");
    const memoEl = document.getElementById("lineup-memo");
    const publishCheckbox = document.getElementById("lineup-publish-checkbox");
    if (!block || !systemSelect) {
        alert("オーダー入力欄が見つかりません。");
        return;
    }

    const system = systemSelect.value || "NORMAL9";
    const memo = memoEl ? memoEl.value.trim() : "";
    const isPublished = publishCheckbox ? publishCheckbox.checked : false;

    const rows = block.querySelectorAll(".lineup-row");
    const starting = [];

    rows.forEach((row) => {
        const order = Number(row.dataset.order);
        const playerSelect = row.querySelector(".lineup-player-select");
        const posSelect = row.querySelector(".lineup-pos-select");

        if (!playerSelect || !playerSelect.value) return;

        starting.push({
            order,
            memberId: playerSelect.value,
            position: posSelect && posSelect.value ? posSelect.value : "",
        });
    });

    try {
        await col.events().doc(currentEventId).set(
            {
                lineup: {
                    system,
                    starting,
                    memo,
                    isPublished,
                },
            },
            { merge: true }
        );

        // メモリ上の currentEventData も更新
        currentEventData.lineup = {
            system,
            starting,
            memo,
            isPublished,
        };
        lineupStarting = starting;

        alert("オーダーを保存しました！");
    } catch (e) {
        console.error("saveLineup error:", e);
        alert(
            "オーダー保存中にエラーが発生しました。コンソールを確認してください。"
        );
    }
}

// ========== 出欠登録ボタン（詳細画面） ==========
function setupButtons() {
    const buttons = document.querySelectorAll("#buttons button");
    buttons.forEach((btn) => {
        btn.addEventListener("click", async () => {
            const status = btn.dataset.status;
            await saveAttendance(status);
            alert("出欠を登録しました！");
            await loadAttendanceList();
            await setupLineupSectionIfNeeded();
        });
    });
}

// 管理者用：削除対象イベントのセレクトを埋める
async function populateDeleteEventSelect() {
    const select = document.getElementById("delete-event-select");
    if (!select) return;

    // 一旦クリアして、先頭にプレースホルダを入れる
    select.innerHTML =
        '<option value="">-- イベントを選択してください --</option>';

    // 日付順に events コレクションを取得
    const snap = await col.events().orderBy("date").get();

    snap.forEach((doc) => {
        const e = doc.data();
        const opt = document.createElement("option");

        // value は eventId（ドキュメント ID）
        opt.value = doc.id;

        // 表示用ラベル
        const parts = [];
        if (e.date) parts.push(e.date);
        if (e.title) parts.push(e.title);
        opt.textContent = parts.join(" ") + ` (${doc.id})`;

        select.appendChild(opt);
    });
}

// 管理者用：編集対象イベントのセレクトを埋める
async function populateEditEventSelect() {
    const select = document.getElementById("admin-edit-select");
    if (!select) return;

    select.innerHTML = '<option value="">新規作成（何も選択しない）</option>';

    const snap = await col.events().orderBy("date").get();

    snap.forEach((doc) => {
        const e = doc.data();
        const opt = document.createElement("option");

        opt.value = doc.id;

        const parts = [];
        if (e.date) parts.push(e.date);
        if (e.title) parts.push(e.title);
        opt.textContent = parts.join(" ") + ` (${doc.id})`;

        select.appendChild(opt);
    });
}

// 管理者用：選択したイベントをフォームに読み込む
async function loadEventToAdminForm(eventId) {
    const idInput = document.getElementById("admin-event-id");
    const titleInput = document.getElementById("admin-title");
    const dateInput = document.getElementById("admin-date");
    const timeInput = document.getElementById("admin-time");
    const placeInput = document.getElementById("admin-place");
    const noteInput = document.getElementById("admin-note");
    const typeSelect = document.getElementById("admin-type");
    const msgEl = document.getElementById("admin-message");

    if (
        !idInput ||
        !titleInput ||
        !dateInput ||
        !timeInput ||
        !placeInput ||
        !noteInput
    ) {
        console.error("管理者用フォームの要素が見つかりません");
        return;
    }

    // 何も選んでいない ⇒ 新規作成モード
    if (!eventId) {
        idInput.disabled = false;
        idInput.value = "";
        titleInput.value = "";
        dateInput.value = "";
        timeInput.value = "";
        placeInput.value = "";
        noteInput.value = "";
        if (typeSelect) typeSelect.value = "";
        if (msgEl) {
            msgEl.textContent =
                "新しいイベントを追加します。必要事項を入力して「イベントを保存」を押してください。";
        }
        return;
    }

    // 既存イベントの読み込み
    try {
        const snap = await col.events().doc(eventId).get();
        if (!snap.exists) {
            if (msgEl) {
                msgEl.textContent =
                    "指定されたイベントが見つかりませんでした。";
            }
            return;
        }

        const e = snap.data();

        idInput.disabled = true; // 既存IDは変更不可
        idInput.value = eventId;
        titleInput.value = e.title || "";
        dateInput.value = e.date || "";
        timeInput.value = e.time || "";
        placeInput.value = e.place || "";
        noteInput.value = e.note || "";
        if (typeSelect) typeSelect.value = e.type || "";

        if (msgEl) {
            msgEl.textContent =
                "既存イベントの内容を読み込みました。編集後に「イベントを保存」を押すと上書きされます。";
        }
    } catch (err) {
        console.error("loadEventToAdminForm error:", err);
        if (msgEl) {
            msgEl.textContent =
                "イベント情報の読み込み中にエラーが発生しました。";
        }
    }
}

// 管理者用：イベントを新規作成／編集して保存
async function createEventFromAdmin() {
    if (!isCurrentUserAdmin()) {
        alert("管理者のみ操作できます");
        return;
    }

    const msgEl = document.getElementById("admin-message");

    const idInput = document.getElementById("admin-event-id");
    const titleInput = document.getElementById("admin-title");
    const dateInput = document.getElementById("admin-date");
    const timeInput = document.getElementById("admin-time");
    const placeInput = document.getElementById("admin-place");
    const noteInput = document.getElementById("admin-note");
    const typeSelect = document.getElementById("admin-type");
    const editSelect = document.getElementById("admin-edit-select");

    const date = (dateInput?.value || "").trim();
    const time = (timeInput?.value || "").trim();
    const place = (placeInput?.value || "").trim();
    const title = (titleInput?.value || "").trim();
    const type = (typeSelect?.value || "").trim();
    const note = (noteInput?.value || "").trim();

    if (!date || !title) {
        alert("date と title は必須です");
        return;
    }

    // eventId の決め方：
    // 1) 入力欄にあればそれを使う
    // 2) 編集セレクトで選択中ならそのIDを使う
    // 3) どちらも無ければ自動採番
    let eventId =
        (idInput?.value || "").trim() || (editSelect?.value || "").trim();
    if (!eventId) {
        eventId = col.events().doc().id;
        if (idInput) idInput.value = eventId;
    }

    try {
        const ref = col.event(eventId);
        const snap = await ref.get();

        const payload = {
            date,
            time,
            place,
            title,
            type,
            note,
            updatedAt: TS(),
        };

        if (!snap.exists) {
            payload.createdAt = TS();
            payload.createdBy = currentUser?.uid || "";
        }

        await ref.set(payload, { merge: true });

        if (msgEl) {
            msgEl.textContent = snap.exists
                ? "イベントを更新しました。"
                : "イベントを作成しました。";
        }

        // 一覧・セレクト類を更新
        await loadEventList();
        await populateEditEventSelect();
        await populateDeleteEventSelect();
    } catch (err) {
        console.error("createEventFromAdmin error:", err);
        if (msgEl)
            msgEl.textContent =
                "保存に失敗しました。コンソールを確認してください。";
        alert("保存に失敗しました。");
    }
}

// 管理者用：選択したイベントをフォームに読み込む
async function loadEventToAdminForm(eventId) {
    const idInput = document.getElementById("admin-event-id");
    const titleInput = document.getElementById("admin-title");
    const dateInput = document.getElementById("admin-date");
    const timeInput = document.getElementById("admin-time");
    const placeInput = document.getElementById("admin-place");
    const noteInput = document.getElementById("admin-note");
    const typeSelect = document.getElementById("admin-type");
    const msgEl = document.getElementById("admin-message");

    if (
        !idInput ||
        !titleInput ||
        !dateInput ||
        !timeInput ||
        !placeInput ||
        !noteInput
    ) {
        console.error("管理者用フォームの要素が見つかりません");
        return;
    }

    // 何も選んでいない ⇒ 新規作成モード
    if (!eventId) {
        idInput.disabled = false;
        idInput.value = "";
        titleInput.value = "";
        dateInput.value = "";
        timeInput.value = "";
        placeInput.value = "";
        noteInput.value = "";
        if (typeSelect) typeSelect.value = "";
        if (msgEl) {
            msgEl.textContent =
                "新しいイベントを追加します。必要事項を入力して「イベントを保存」を押してください。";
        }
        return;
    }

    // 既存イベントの読み込み
    try {
        const snap = await col.events().doc(eventId).get();
        if (!snap.exists) {
            if (msgEl) {
                msgEl.textContent =
                    "指定されたイベントが見つかりませんでした。";
            }
            return;
        }

        const e = snap.data();

        idInput.disabled = true; // 既存IDは変更不可
        idInput.value = eventId;
        titleInput.value = e.title || "";
        dateInput.value = e.date || "";
        timeInput.value = e.time || "";
        placeInput.value = e.place || "";
        noteInput.value = e.note || "";
        if (typeSelect) typeSelect.value = e.type || "";

        if (msgEl) {
            msgEl.textContent =
                "既存イベントの内容を読み込みました。編集後に「イベントを保存」を押すと上書きされます。";
        }
    } catch (err) {
        console.error("loadEventToAdminForm error:", err);
        if (msgEl) {
            msgEl.textContent =
                "イベント情報の読み込み中にエラーが発生しました。";
        }
    }
}

// 管理者：イベント削除
async function deleteEventFromAdmin() {
    const eventId = (
        document.getElementById("delete-event-select")?.value || ""
    ).trim();

    if (!eventId) {
        alert("削除するイベントを選択してください");
        return;
    }

    const respSnap = await col.responses(eventId).get();
    const batch = db.batch();
    respSnap.forEach((doc) => batch.delete(doc.ref));
    batch.delete(col.event(eventId));
    await batch.commit();

    alert("イベントを削除しました");
    await loadEventList();
}

// 管理者パネルの表示とイベントリスナー設定

// 管理者フォームをクリア
function clearAdminForm() {
    const idInput = document.getElementById("admin-event-id");
    const titleInput = document.getElementById("admin-title");
    const dateInput = document.getElementById("admin-date");
    const timeInput = document.getElementById("admin-time");
    const placeInput = document.getElementById("admin-place");
    const noteInput = document.getElementById("admin-note");
    const typeSelect = document.getElementById("admin-type");
    const msgEl = document.getElementById("admin-message");

    if (idInput) idInput.value = "";
    if (titleInput) titleInput.value = "";
    if (dateInput) dateInput.value = "";
    if (timeInput) timeInput.value = "";
    if (placeInput) placeInput.value = "";
    if (noteInput) noteInput.value = "";
    if (typeSelect) typeSelect.value = "";

    if (msgEl) msgEl.textContent = "";
}

// 管理者UIの初期化（セレクトのロード＆ボタンのイベント紐付け）
async function setupAdminUI() {
    if (!isCurrentUserAdmin()) return;

    const root = document.getElementById("admin-panel"); // 何でもOK
    if (root && root.dataset.initialized) return;
    if (root) root.dataset.initialized = "1";

    await populateEditEventSelect();
    await populateDeleteEventSelect();

    const editSelect = document.getElementById("admin-edit-select");
    if (editSelect && !editSelect.dataset.listenerAdded) {
        editSelect.dataset.listenerAdded = "1";
        editSelect.addEventListener("change", async () => {
            const eventId = (editSelect.value || "").trim();
            if (!eventId) {
                clearAdminForm();
                return;
            }
            await loadEventToAdminForm(eventId);
        });
    }

    const saveBtn = document.getElementById("admin-save-btn");
    if (saveBtn && !saveBtn.dataset.listenerAdded) {
        saveBtn.dataset.listenerAdded = "1";
        saveBtn.addEventListener("click", async () => {
            await createEventFromAdmin(); // 新規/更新をこの関数に統一
        });
    }

    const deleteBtn = document.getElementById("admin-delete-btn");
    if (deleteBtn && !deleteBtn.dataset.listenerAdded) {
        deleteBtn.dataset.listenerAdded = "1";
        deleteBtn.addEventListener("click", async () => {
            const eventId = (
                document.getElementById("delete-event-select")?.value || ""
            ).trim();
            if (!eventId) {
                alert("削除するイベントを選択してください");
                return;
            }
            const ok = confirm(
                `イベントを削除しますか？\n(eventId: ${eventId})\n出欠データも削除されます。`
            );
            if (!ok) return;

            await deleteEventFromAdmin(eventId);
            await populateDeleteEventSelect();
            await populateEditEventSelect();
            await refreshJoinRequestsPanel(getTeamId());
        });
    }
}

function showAdminPanelIfNeeded() {
    // 管理者関連UI（存在するものだけ表示/非表示）
    const ids = ["admin-panel", "admin-event-delete"];
    const isAdmin = isCurrentUserAdmin();


    console.log("[debug] showAdminPanelIfNeeded", {
        isAdmin,
        currentUserRole,
    });

    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = isAdmin ? "block" : "none";
    });
}

// ========== 出席率ランキング ==========
async function loadStats(resultDiv) {
    // 参加率（◎/〇）をメンバー別に集計
    // ※ attendance コレクションは使わず、events/{eventId}/responses を集計する
    const [membersSnap, eventsSnap] = await Promise.all([
        col.members().where("isActive", "==", true).get(),
        col.events().get(),
    ]);

    const totalEvents = eventsSnap.size;
    const statsByUid = {};

    membersSnap.forEach((m) => {
        const d = m.data() || {};
        statsByUid[m.id] = {
            name: d.displayName || m.id,
            attendCount: 0,
        };
    });

    if (totalEvents === 0) {
        resultDiv.textContent = "イベントがありません。";
        return;
    }

    // teamId と status(in) で responses をまとめて取得
    const okSnap = await db
        .collectionGroup("responses")
        .where("teamId", "==", TEAM_ID)
        .where("status", "in", ATTEND_OK_STATUSES)
        .get();

    okSnap.forEach((doc) => {
        const r = doc.data() || {};
        const uid = r.uid || doc.id;
        if (statsByUid[uid]) statsByUid[uid].attendCount += 1;
    });

    // 表示（参加率順）
    const rows = Object.entries(statsByUid)
        .map(([uid, s]) => ({
            uid,
            name: s.name,
            attendCount: s.attendCount,
            rate: Math.round((s.attendCount / totalEvents) * 1000) / 10, // 小数1桁
        }))
        .sort((a, b) => b.rate - a.rate);

    resultDiv.innerHTML = `
    <div class="stats-summary">イベント数: ${totalEvents}</div>
    <table class="stats-table">
      <thead><tr><th>名前</th><th>参加(◎/〇)</th><th>参加率</th></tr></thead>
      <tbody>
        ${rows
            .map(
                (r) =>
                    `<tr><td>${escapeHtml(r.name)}</td><td>${r.attendCount
                    }</td><td>${r.rate}%</td></tr>`
            )
            .join("")}
      </tbody>
    </table>
  `;
}

// 管理者だけランキングパネルを見せる
async function showStatsPanelIfNeeded() {
    // ※ 管理者だけ「集計ボタン」を表示する
    const btn = document.getElementById("load-stats-btn");
    const resultDiv = document.getElementById("stats-result");
    if (!btn || !resultDiv) return;

    if (!isCurrentUserAdmin()) {
        btn.style.display = "none";
        resultDiv.style.display = "none";
        return;
    }

    btn.style.display = "inline-block";
    resultDiv.style.display = "block";

    if (!btn.dataset.listenerAdded) {
        btn.addEventListener("click", async () => {
            resultDiv.textContent = "集計中...";
            try {
                await loadStats(resultDiv);
            } catch (e) {
                console.error(e);
                resultDiv.textContent =
                    "集計に失敗しました（コンソールを確認してください）";
            }
        });
        btn.dataset.listenerAdded = "1";
    }
}

// ========== みんなのメモ（統一版：teams/{teamId}/memos） ==========
const MEMO_PAGE_SIZE = 10;
let memoLastVisible = null;
let memoListInitialized = false;

function canDeleteMemo(authorUid) {
    if (!currentUser) return false;
    if (isCurrentUserAdmin && isCurrentUserAdmin()) return true;
    return currentUser.uid === authorUid;
}

function setupMemoSection() {
    const card = document.getElementById("memo-card");
    const textarea = document.getElementById("memo-input");
    const submitBtn = document.getElementById("memo-submit-btn");
    const moreBtn = document.getElementById("memo-load-more-btn");
    const listDiv = document.getElementById("memo-list");
    if (!card || !textarea || !submitBtn || !moreBtn || !listDiv) return;

    // イベント委譲（1回だけ）
    if (!memoListInitialized) {
        memoListInitialized = true;

        listDiv.addEventListener("click", async (e) => {
            const target = e.target;

            // 続きを読む/閉じる
            if (target.classList.contains("memo-toggle-btn")) {
                const item = target.closest(".memo-item");
                const body = item?.querySelector(".memo-body");
                if (!body) return;
                const expanded = body.classList.toggle("expanded");
                target.textContent = expanded ? "閉じる" : "続きを読む";
                return;
            }

            // 削除
            if (target.classList.contains("memo-delete-btn")) {
                const memoId = target.dataset.id;
                const authorUid = target.dataset.authorUid;
                if (!memoId) return;

                // 念のためUIでもガード
                if (!canDeleteMemo(authorUid)) {
                    alert("このメモは削除できません。");
                    return;
                }

                if (!confirm("このメモを削除しますか？")) return;

                try {
                    await col.memos().doc(memoId).delete();
                    target.closest(".memo-item")?.remove();
                } catch (err) {
                    console.error(err);
                    alert("メモの削除に失敗しました。");
                }
            }
        });
    }

    // 投稿
    submitBtn.addEventListener("click", async () => {
        const text = textarea.value.trim();
        if (!text) return alert("メモを入力してください。");
        if (!currentUser) return alert("ログイン情報が取得できません。");

        submitBtn.disabled = true;
        submitBtn.textContent = "送信中...";

        try {
            let authorName = currentUser.displayName || "Unknown";

            // team配下 members から表示名を優先取得
            const mDoc = await col.members().doc(currentUser.uid).get();
            if (mDoc.exists) {
                const m = mDoc.data() || {};
                if (m.displayName) authorName = m.displayName;
            }

            await col.memos().add({
                text,
                authorUid: currentUser.uid,
                authorName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });

            textarea.value = "";
            memoLastVisible = null;
            await loadMemos(true);
        } catch (err) {
            console.error(err);
            alert("メモの投稿に失敗しました。");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "メモを投稿する";
        }
    });

    // もっと見る
    moreBtn.addEventListener("click", async () => loadMemos(false));

    memoLastVisible = null;
    loadMemos(true);
}

async function loadMemos(reset = false) {
    const listDiv = document.getElementById("memo-list");
    const moreBtn = document.getElementById("memo-load-more-btn");
    if (!listDiv) return;

    if (reset) {
        listDiv.innerHTML = "";
        memoLastVisible = null;
    }

    try {
        // members マップ（uid -> displayName）
        const membersSnap = await col.members().get();
        const memberNameMap = {};
        membersSnap.forEach((mDoc) => {
            const m = mDoc.data() || {};
            memberNameMap[mDoc.id] = m.displayName || null;
        });

        let query = col.memos().orderBy("createdAt", "desc").limit(MEMO_PAGE_SIZE);
        if (memoLastVisible) query = query.startAfter(memoLastVisible);

        const snap = await query.get();
        if (snap.empty) {
            if (reset) listDiv.innerHTML = "<p>まだメモはありません。</p>";
            if (moreBtn) moreBtn.style.display = "none";
            return;
        }

        if (moreBtn) moreBtn.style.display = "block";
        memoLastVisible = snap.docs[snap.docs.length - 1];

        snap.forEach((doc) => {
            const data = doc.data() || {};
            const authorName =
                memberNameMap[data.authorUid] || data.authorName || "Unknown";

            const createdAt = data.createdAt ? formatDateTime(data.createdAt) : "";

            const item = document.createElement("div");
            item.className = "memo-item";

            const deletable = canDeleteMemo(data.authorUid);

            item.innerHTML = `
        <div class="memo-header">
          <div class="memo-author">${escapeHtml(authorName)}</div>
          <div class="memo-header-right">
            <span class="memo-date">${createdAt}</span>
            ${deletable
                    ? `<button class="memo-delete-btn" data-id="${doc.id}" data-author-uid="${data.authorUid}">🗑</button>`
                    : ""
                }
          </div>
        </div>
        <div class="memo-body">${escapeHtml(data.text || "")}</div>
        <button class="memo-toggle-btn">続きを読む</button>
      `;

            listDiv.appendChild(item);
        });

        // 10 件未満なら「もっと見る」を隠す
        if (moreBtn) {
            if (snap.size < 10) {
                moreBtn.style.display = "none";
            } else {
                moreBtn.style.display = "inline-block";
            }
        }
    } catch (e) {
        if (!isPermissionDenied(e)) {
            console.error("loadMemos failed:", e);
        }
        if (reset) listDiv.innerHTML = "<p>メモを表示する権限がありません。</p>";
        if (moreBtn) moreBtn.style.display = "none";
    }
}


// ========== チームUI（作成 / 参加 / 切替 / 参加申請） ==========

function $(id) {
    return document.getElementById(id);
}

function getPreferredDisplayName() {
    return (
        liffProfile?.displayName ||
        firebase.auth().currentUser?.displayName ||
        currentUser?.displayName ||
        "ゲスト"
    );
}

function show(el, on = true) {
    if (!el) return;
    el.classList.toggle("hidden", !on);
}

function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text ?? "";
}

function setHtml(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html ?? "";
}

function normalizeTeamId(raw) {
    return (raw || "").trim();
}

async function loadTeamDoc(teamId) {
    if (!teamId) return null;
    try {
        const snap = await col.team(teamId).get();
        return snap.exists ? { id: snap.id, ...snap.data() } : null;
    } catch (e) {
        if (!isPermissionDenied(e)) {
            console.warn("loadTeamDoc failed:", e);
        }
        return null;
    }
}

// 申請作成/状態表示
async function createJoinRequest(teamId) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error("未ログインです");

    const uid = user.uid;
    const displayName = user.displayName || currentUser?.displayName || "ゲスト";

    const ref = db.collection("teams").doc(teamId).collection("joinRequests").doc(uid);

    await ref.set({
        uid,
        displayName,
        status: "pending",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return true;
}

function bindJoinRequestUI(teamId) {
    const btn = document.getElementById("join-request-btn");
    const statusEl = document.getElementById("join-request-status");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        try {
            btn.disabled = true;
            if (statusEl) statusEl.textContent = "申請中...";

            await createJoinRequest(teamId);

            if (statusEl) statusEl.textContent = "申請しました（承認待ち）";
            watchMyJoinRequestStatus(teamId); // 状態監視
        } catch (e) {
            console.error(e);
            if (statusEl) statusEl.textContent = "申請に失敗しました。権限/チーム設定を確認してください。";
        } finally {
            btn.disabled = false;
        }
    });
}

function watchMyJoinRequestStatus(teamId) {
    const user = firebase.auth().currentUser;
    const statusEl = document.getElementById("join-request-status");
    if (!user || !statusEl) return;

    const uid = user.uid;
    const memberRef = db.collection("teams").doc(teamId).collection("members").doc(uid);

    // members が作られたら「承認された」と判断
    return memberRef.onSnapshot((doc) => {
        if (doc.exists) {
            statusEl.textContent = "承認されました！再読み込みして続行してください。";
        }
    });
}

// 一覧表示
async function loadJoinRequests(teamId) {
    const snap = await db.collection("teams").doc(teamId).collection("joinRequests")
        .orderBy("createdAt", "desc")
        .get();

    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function renderJoinRequests(reqs) {
    const list = document.getElementById("join-requests-list");
    if (!list) return;

    if (!reqs.length) {
        list.innerHTML = "<div class='muted'>申請はありません</div>";
        return;
    }

    list.innerHTML = reqs.map(r => `
    <div class="row" data-uid="${r.uid}">
      <div>
        <div><b>${escapeHtml(r.displayName || r.uid)}</b></div>
        <div class="muted">${escapeHtml(r.uid)}</div>
      </div>
      <div class="actions">
        <button class="btn approve" data-approve="${r.uid}">承認</button>
        <button class="btn reject" data-reject="${r.uid}">却下</button>
      </div>
    </div>
  `).join("");

    // イベント登録
    list.querySelectorAll("[data-approve]").forEach(btn => {
        btn.addEventListener("click", () => approveJoinRequest(getTeamId(), btn.dataset.approve));
    });
    list.querySelectorAll("[data-reject]").forEach(btn => {
        btn.addEventListener("click", () => rejectJoinRequest(getTeamId(), btn.dataset.reject));
    });
}

async function refreshJoinRequestsPanel(teamId) {
    const panel = document.getElementById("join-requests-panel");
    if (panel) panel.style.display = "block";

    const reqs = await loadJoinRequests(teamId);
    renderJoinRequests(reqs);
}

// 承認/却下
async function approveJoinRequest(teamId, uid) {
    // joinRequest doc を取得して表示名などを使う
    const jrRef = db.collection("teams").doc(teamId).collection("joinRequests").doc(uid);
    const jrDoc = await jrRef.get();
    if (!jrDoc.exists) return;

    const data = jrDoc.data() || {};
    const displayName = data.displayName || "ゲスト";

    const memberRef = db.collection("teams").doc(teamId).collection("members").doc(uid);

    // members 作成 → joinRequests 削除
    await memberRef.set({
        uid,
        displayName,
        role: "member",
        isActive: true,
        joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await jrRef.delete();

    await refreshJoinRequestsPanel(teamId);
}

async function rejectJoinRequest(teamId, uid) {
    const jrRef = db.collection("teams").doc(teamId).collection("joinRequests").doc(uid);
    await jrRef.delete();
    await refreshJoinRequestsPanel(teamId);
}

// エスケープ処理
function escapeHtml(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}



async function refreshMyTeamsList() {
    const listEl = document.getElementById("my-teams-list");
    if (!listEl) return [];

    listEl.textContent = "読み込み中...";

    try {
        // firebase.auth().currentUser を最優先（currentUser より確実）
        const uid = firebase.auth().currentUser?.uid || currentUser?.uid || window.currentUid;
        if (!uid) {
            listEl.textContent = "未ログインです。";
            return [];
        }

        // ★ collectionGroup で members を検索する場合は documentId() ではなく uid フィールドで絞る
        const snap = await db
            .collectionGroup("members")
            .where("uid", "==", uid)
            .where("isActive", "==", true)
            .get();

        const teamIds = [...new Set(snap.docs.map(d => d.ref.parent.parent.id))];

        if (teamIds.length === 0) {
            listEl.textContent = "参加中のチームはありません。";
            return [];
        }

        // teams/{teamId} を取得（rules: member なら読める / open ならログイン済みで読める）
        const teamDocs = await Promise.all(
            teamIds.map(teamId => db.collection("teams").doc(teamId).get())
        );

        const myTeams = teamDocs
            .filter(d => d.exists)
            .map(d => ({ teamId: d.id, ...d.data() }));

        // 描画
        listEl.innerHTML = "";
        myTeams.forEach(team => {
            const row = document.createElement("div");
            row.className = "my-team-row";
            row.innerHTML = `
        <button class="btn btn-sub team-select-btn" data-teamid="${team.teamId}">
          ${escapeHtml(team.name || team.teamId)}
        </button>
      `;
            listEl.appendChild(row);
        });

        // クリックで切替
        listEl.querySelectorAll(".team-select-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                const teamId = btn.dataset.teamid;
                if (!teamId) return;
                setTeamId(teamId);
                await openTeam(teamId);
            });
        });

        return myTeams;
    } catch (e) {
        if (!isPermissionDenied(e)) {
            console.warn("refreshMyTeamsList failed (ignored):", e);
        }
        listEl.textContent = "参加中のチームはありません。";
        return [];
    }
}


function updateTeamHeader(teamDoc) {
    if (!teamDoc) {
        setText("current-team-label", "未選択");
        setText("current-team-id", "");
        return;
    }
    setText("current-team-label", teamDoc.name || "(no name)");
    setText("current-team-id", `teamId: ${teamDoc.id}`);
}

function applyNotSelectedUi() {
    // チーム未選択：イベント機能は隠し、チームパネルを開く
    show($("join-request-card"), false);
    const listView = $("event-list-view");
    const detailView = $("event-detail-view");
    if (listView) listView.style.display = "block";
    if (detailView) detailView.style.display = "none";

    // イベント一覧などは見せない（混乱防止）
    show($("event-list"), false);
    show($("memo-card"), false);
    show($("stats-panel"), false);
    show($("admin-panel"), false);

    const myBtn = $("open-my-attendance-btn");
    if (myBtn) myBtn.style.display = "none";

    show($("team-panel"), true);
    setText("event-list", "");
}

async function applyGuestUi(teamDoc) {
    // 非member：イベント機能は隠し、参加申請カードを表示
    const myBtn = $("open-my-attendance-btn");
    if (myBtn) myBtn.style.display = "none";

    show($("event-list"), false);
    show($("memo-card"), false);
    show($("stats-panel"), false);
    show($("admin-panel"), false);
    show($("team-panel"), false);
    const listView = $("event-list-view");
    const detailView = $("event-detail-view");
    if (listView) listView.style.display = "block";
    if (detailView) detailView.style.display = "none";

    const joinCard = $("join-request-card");
    show(joinCard, true);
    if (joinCard) {
        joinCard.classList.remove("hidden");
        joinCard.style.display = "block";
        const teamCard = $("team-card");
        if (teamCard && joinCard.parentElement !== teamCard.parentElement) {
            teamCard.insertAdjacentElement("afterend", joinCard);
        }
        joinCard.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    setText("event-list", "");



    // open 以外（invite）なら申請ボタンは不可
    let canRequest = false;
    if (teamDoc?.joinMode === "open") {
        canRequest = true;
    }

    let requestMessage = "";
    let requestStatus = "ready"; // ready | pending | disabled

    console.log("[debug] applyGuestUi init", {
        teamDoc,
        joinMode: teamDoc?.joinMode,
    });
    console.log("[debug] canRequest initial", {
        canRequest,
        requestStatus,
        requestMessage,
    });

    if (!teamDoc) {
        canRequest = false;
        requestStatus = "disabled";
        requestMessage =
            "チーム情報を取得できませんでした。権限設定を確認してください。";
    }
    if (teamDoc && teamDoc.joinMode !== "open") {
        canRequest = false;
        requestStatus = "disabled";
        requestMessage =
            "このチームは招待制のため、管理者からの招待リンクが必要です。";
    }


    // 既に申請済みならボタンを無効化
    if (canRequest) {
        try {
            const uid = firebase.auth().currentUser?.uid;
            const teamId = getTeamId();
            if (uid && teamId) {
                const req = await col.joinRequest(teamId, uid).get();
                if (req.exists) {
                    canRequest = false;
                    requestStatus = "pending";
                    requestMessage =
                        "すでに参加申請済みです。管理者の承認をお待ちください。";
                }
            }
        } catch (e) {
            if (!isPermissionDenied(e)) {
                console.warn("read joinRequest failed", e);
            }
        }
    }

    if (requestBtn) {
        requestBtn.textContent =
            requestStatus === "pending" ? "承認待ちです" : "参加申請する";

        console.log("[debug] canRequest before render", {
            canRequest,
            requestStatus,
            requestMessage,
        });


        requestBtn.toggleAttribute("disabled", !canRequest);
    }
    if (!canRequest) {
        setText("join-request-msg", requestMessage);
    } else {
        setText("join-request-msg", "");
    }
}



function applyMemberUi() {
    // member：通常機能を表示（既存の描画ロジックに任せる）
    show($("join-request-card"), false);
    const myBtn = $("open-my-attendance-btn");
    if (myBtn) myBtn.style.display = "inline-block";
    show($("event-list"), true);
    show($("memo-card"), true);
    show($("stats-panel"), true);
    // admin-panel は role 判定後に isCurrentUserAdmin() で切替
}

async function openTeam(teamId) {
    const tid = normalizeTeamId(teamId);
    if (!tid) return;

    setTeamId(tid, { pushUrl: true, save: true });

    // チーム表示更新
    const teamDoc = await loadTeamDoc(tid);
    if (!teamDoc) {
        updateTeamHeader({ id: tid, name: "(チームが見つかりません)" });
        applyNotSelectedUi();
        return;
    }
    updateTeamHeader(teamDoc);

    // 自分が member か判定（存在すれば role も読む）
    if (TEAM_ID) {
        await ensureMember(
            TEAM_ID,
            currentUser.uid,
            currentUser.displayName || "ゲスト",
            "member"
        );
    } // memberならrole取得＆軽い更新、非memberならguest

    if (currentUserRole === "guest") {
        await applyGuestUi(teamDoc);
        return;
    }

    // memberなら通常UIへ
    applyMemberUi();

    // admin（参加申請の承認）
    showAdminPanelIfNeeded();
    if (isCurrentUserAdmin()) {
        await renderAdminJoinRequests();
    }

    // 既存ルーティング（イベント一覧/詳細）を再描画
    currentEventId = getEventIdFromUrl();
    const listView = $("event-list-view");
    const detailView = $("event-detail-view");
    if (!currentEventId) {
        if (listView) listView.style.display = "block";
        if (detailView) detailView.style.display = "none";
        await loadEventList();
    } else {
        if (listView) listView.style.display = "none";
        if (detailView) detailView.style.display = "block";
        await loadEvent();
    }

    // 参加中チーム一覧も更新
    await refreshMyTeamsList();
}

async function createTeamFromUi() {
    const name = normalizeTeamId($("create-team-name")?.value);
    const sportType = $("create-team-sport")?.value || "other";
    const joinMode = $("create-team-joinmode")?.value || "open";

    const resultEl = $("create-team-result");
    if (resultEl) resultEl.textContent = "";

    if (!name) {
        if (resultEl) resultEl.textContent = "チーム名を入力してください。";
        return;
    }

    const uid = firebase.auth().currentUser?.uid;
    if (!uid) {
        if (resultEl) resultEl.textContent = "未ログインです。";
        return;
    }

    // teamId を生成（短め）
    const teamId =
        "t_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 8);

    try {
        // teams/{teamId}
        await col.team().doc(teamId).set({
            createdAt: TS(),
            name,
            ownerUid: uid,
            plan: "free",
            sportType,
            joinMode,
        });

        // members/{uid} を owner で作成（bootstrap）
        await col.team().doc(teamId).collection("members").doc(uid).set({
            displayName: getPreferredDisplayName(),
            isActive: true,
            joinedAt: TS(),
            role: "owner",
            uid: currentUser.uid,
            updatedAt: TS(),
        });

        if (resultEl) {
            resultEl.textContent = `作成しました！ teamId: ${teamId}`;
        }

        // 作成したチームへ切替
        await openTeam(teamId);
    } catch (e) {
        console.error(e);
        if (resultEl)
            resultEl.textContent =
                "作成に失敗しました。権限/Rulesを確認してください。";
    }
}

async function openTeamFromUi() {
    const tid = normalizeTeamId($("join-team-id")?.value);
    const resultEl = $("join-team-result");
    if (resultEl) resultEl.textContent = "";
    if (!tid) {
        if (resultEl) resultEl.textContent = "teamId を入力してください。";
        return;
    }
    await openTeam(tid);
}

// 参加申請
async function submitJoinRequest() {
    const teamId = getTeamId();
    const msgEl = $("join-request-msg");
    const btn = $("join-request-btn");
    if (msgEl) msgEl.textContent = "";

    if (!teamId) {
        if (msgEl) msgEl.textContent = "teamId が未選択です。";
        return;
    }

    const uid = firebase.auth().currentUser?.uid;
    if (!uid) {
        if (msgEl) msgEl.textContent = "未ログインです。";
        return;
    }

    // teamDoc は joinMode=open のときのみ読める前提
    const teamDoc = await loadTeamDoc(teamId);
    if (!teamDoc) {
        if (msgEl) msgEl.textContent = "チーム情報を取得できませんでした。";
        return;
    }
    if (teamDoc.joinMode !== "open") {
        if (msgEl) msgEl.textContent = "このチームは招待制です。";
        return;
    }

    try {
        if (btn) btn.disabled = true;
        await col.joinRequest(teamId, uid).set({
            displayName: getPreferredDisplayName(),
            uid,
            createdAt: TS(),
        });
        if (btn) btn.textContent = "承認待ちです";
        if (msgEl) {
            msgEl.textContent =
                "参加申請しました！管理者の承認をお待ちください。";
        }
    } catch (e) {
        console.error(e);
        if (msgEl) msgEl.textContent = "参加申請に失敗しました。";
    } finally {
        if (btn && btn.textContent !== "承認待ちです") {
            btn.disabled = false;
        }
    }
}




async function renderAdminJoinRequests() {
    const box = $("admin-join-requests-list");
    if (!box) return;

    box.textContent = "読み込み中…";

    try {
        const snap = await col
            .joinRequests()
            .orderBy("createdAt", "desc")
            .get();
        if (snap.empty) {
            box.textContent = "承認待ちはありません。";
            return;
        }

        const rows = snap.docs.map((d) => {
            const data = d.data() || {};
            const dn = data.displayName || "";
            const uid = d.id;
            return `
              <div class="req-item">
                <div class="meta">
                  <div class="name">${escapeHtml(dn)}</div>
                  <div class="uid">${escapeHtml(uid)}</div>
                </div>
                <div class="actions">
                  <button class="pill-button" type="button" data-approve-uid="${escapeHtml(
                uid
            )}">承認</button>
                  <button class="pill-button" type="button" data-reject-uid="${escapeHtml(
                uid
            )}">却下</button>
                </div>
              </div>
            `;
        });

        box.innerHTML = rows.join("");

        box.querySelectorAll("[data-approve-uid]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const uid = btn.getAttribute("data-approve-uid");
                await approveJoinRequest(uid);
            });
        });
        box.querySelectorAll("[data-reject-uid]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const uid = btn.getAttribute("data-reject-uid");
                await rejectJoinRequest(uid);
            });
        });
    } catch (e) {
        console.error(e);
        box.textContent = "読み込みに失敗しました。";
    }
}

// 管理者：承認
async function approveJoinRequest(uid) {
    const teamId = getTeamIdFromQuery();
    if (!teamId || !uid) return;

    try {
        // 申請doc取得（表示名などを拾う）
        const reqSnap = await col.joinRequest(teamId, uid).get();
        const reqData = reqSnap.exists ? reqSnap.data() : {};

        // members/{uid} を作成（この時点でその人はチーム参加扱い）
        await col.member(teamId, uid).set(
            {
                uid,
                displayName: reqData?.displayName || "",
                isActive: true,
                role: "member", // 承認された側は member にする（owner にしない）
                joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        // 申請は削除（または status approved にして残す運用でもOK）
        await col.joinRequest(teamId, uid).delete();

        // 管理者の申請一覧を更新
        await renderAdminJoinRequests();
        alert("承認しました！");
    } catch (e) {
        console.error("approveJoinRequest failed:", e);
        alert("承認に失敗しました。コンソールを確認してください。");
    }
}



// 管理者：却下
async function rejectJoinRequest(uid) {
    const teamId = getTeamIdFromQuery();
    if (!teamId || !uid) return;

    try {
        await col.joinRequest(teamId, uid).delete();
        await renderAdminJoinRequests();
        alert("却下しました。");
    } catch (e) {
        console.error("rejectJoinRequest failed:", e);
        alert("却下に失敗しました。コンソールを確認してください。");
    }
}



function bindTeamUI() {
    // パネル開閉
    $("open-team-panel-btn")?.addEventListener("click", () => {
        const panel = $("team-panel");
        if (!panel) return;
        panel.classList.toggle("hidden");
        // 開いたら一覧更新
        if (!panel.classList.contains("hidden")) {
            refreshMyTeamsList();
        }
    });

    // 共有リンクコピー
    $("copy-team-url-btn")?.addEventListener("click", async () => {
        const teamId = getTeamId();
        if (!teamId) {
            alert("teamId が未選択です。");
            return;
        }
        const url = new URL(location.href);
        url.searchParams.set("teamId", teamId);
        try {
            await navigator.clipboard.writeText(url.toString());
            alert("共有リンクをコピーしました！");
        } catch (e) {
            console.warn(e);
            prompt(
                "コピーできない場合は、これをコピーしてください：",
                url.toString()
            );
        }
    });

    // チーム作成
    $("create-team-btn")?.addEventListener("click", createTeamFromUi);

    // teamId指定で開く
    $("join-team-btn")?.addEventListener("click", openTeamFromUi);

    // 参加申請
    $("join-request-btn")?.addEventListener("click", submitJoinRequest);
}

// 自分の所属チーム一覧を UI に反映する（安全版）
function renderMyTeams(myTeams) {
    const teams = Array.isArray(myTeams) ? myTeams : [];

    // ありがちな候補ID（どれか1つでもあれば動く）
    const listEl =
        document.getElementById("my-teams-list") ||
        document.getElementById("myTeamsList") ||
        document.getElementById("my-teams");

    const selectEl =
        document.getElementById("my-teams-select") ||
        document.getElementById("team-switch-select") ||
        document.getElementById("teamSelect");

    // 1) <select> があるなら option を作る
    if (selectEl) {
        selectEl.innerHTML = ""; // クリア

        // 先頭にプレースホルダ
        const ph = document.createElement("option");
        ph.value = "";
        ph.textContent = teams.length
            ? "チームを選択…"
            : "所属チームがありません";
        selectEl.appendChild(ph);

        for (const t of teams) {
            const opt = document.createElement("option");
            opt.value = t.teamId || "";
            opt.textContent = t.name
                ? `${t.name}（${t.teamId}）`
                : t.teamId || "(no id)";
            selectEl.appendChild(opt);
        }
    }

    // 2) リスト表示領域があるなら簡易表示
    if (listEl) {
        listEl.innerHTML = "";

        if (!teams.length) {
            const p = document.createElement("p");
            p.textContent = "所属チームはまだありません。";
            listEl.appendChild(p);
            return;
        }

        const ul = document.createElement("ul");
        ul.style.margin = "8px 0";
        ul.style.paddingLeft = "18px";

        for (const t of teams) {
            const li = document.createElement("li");
            li.textContent = t.name
                ? `${t.name}（${t.teamId}）`
                : t.teamId || "(no id)";
            ul.appendChild(li);
        }

        listEl.appendChild(ul);
    }
}

async function loadMyMemberInfoReadOnly(teamId) {
    try {
        const uid = currentUser?.uid || window.currentUid;
        if (!uid) return false;

        const ref = db.collection("teams").doc(teamId).collection("members").doc(uid);
        const doc = await ref.get();


        console.log("[debug] loadMyMemberInfoReadOnly", {
            teamId,
            uid,
            exists: doc.exists,
            data: doc.exists ? doc.data() : null,
        });

        if (!doc.exists) {
            currentUserRole = "guest";
            return false;
        }

        const data = doc.data() || {};
        currentUserRole = data.role || "member";
        return true;
    } catch (e) {
        if (!isPermissionDenied(e)) {
            console.error("loadMyMemberInfoReadOnly failed:", e);
        }
        currentUserRole = "guest";
        return false;
    }
}


// ========== メイン処理 ==========
async function main() {
    try {
        console.log("=== main() 開始 ===");

        db = firebase.firestore();
        console.log("Firestore 初期化 OK");

        const user = await initAuth();

        // 先に currentUser を確定
        currentUser = { uid: user.uid, displayName: user.displayName || "" };
        window.currentUid = user.uid;

        // UIバインド（認証）
        bindAuthUI();
        console.log("Auth 初期化 OK:", currentUser);

        // ① 所属チーム取得 → 描画
        const myTeams = await refreshMyTeamsList();

        // チームUI（選択・作成・参加ボタンなど）
        bindTeamUI();

        // ② teamId 未選択なら、チームパネル出して終了（イベント読み込み等はしない）
        const tid = getTeamId(); // ★ここで統一
        if (!tid) {
            updateTeamHeader(null);
            applyNotSelectedUi();
            console.log("teamId 未選択なので終了");
            return;
        }

        const teamDoc = await loadTeamDoc(tid);
        updateTeamHeader(teamDoc || { id: tid, name: "(取得不可)" });

        const isMemberNow = await loadMyMemberInfoReadOnly(tid);

        console.log("[debug] openTeam role check", {
            tid,
            isMemberNow,
            currentUserRole,
        });


        // 未所属なので guest UI で停止…のところで
        bindJoinRequestUI(getTeamId());
        watchMyJoinRequestStatus(getTeamId());

        // ⑤ ここから先は「所属済み」のユーザーだけ
        applyMemberUi();

        // admin（参加申請の承認）
        showAdminPanelIfNeeded();
        if (isCurrentUserAdmin()) {
            await renderAdminJoinRequests();
        }

        currentEventId = getEventIdFromUrl();
        console.log("currentEventId =", currentEventId);

        const listView = document.getElementById("event-list-view");
        const detailView = document.getElementById("event-detail-view");

        if (!currentEventId) {
            console.log("一覧モードに入ります");
            listView.style.display = "block";
            detailView.style.display = "none";

            await loadEventList();
            setupMemoSection();
            showStatsPanelIfNeeded();
            await setupAdminUI();

            const openMyBtn = document.getElementById("open-my-attendance-btn");
            const myView = document.getElementById("my-attendance-view");

            if (openMyBtn && myView) {
                openMyBtn.addEventListener("click", () => {
                    listView.style.display = "none";
                    myView.style.display = "block";
                    loadMyAttendance();
                });
            }

            const backMyBtn = document.getElementById("back-to-events-btn");
            if (backMyBtn && myView) {
                backMyBtn.addEventListener("click", () => {
                    myView.style.display = "none";
                    listView.style.display = "block";
                });
            }
        } else {
            console.log("詳細モードに入ります");
            listView.style.display = "none";
            detailView.style.display = "block";

            setupBackButton();
            await loadEvent();
            await loadAttendanceList();
            setupButtons();
        }

        console.log("=== main() 正常終了 ===");
    } catch (e) {
        if (isPermissionDenied(e)) {
            return;
        }
        console.error("main() でエラー:", e);
        alert("初期化中にエラーが発生しました。コンソールを確認してください。");
    }
}

window.addEventListener("load", main);
