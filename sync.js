import { CROTTY_FIREBASE_CONFIG } from "./sync-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const statusEl = document.getElementById("syncStatus");
const descriptionEl = document.getElementById("syncDescription");
const actionsEl = document.getElementById("syncActions");
const codeDisplayEl = document.getElementById("syncCodeDisplay");
const dialogEl = document.getElementById("syncDialog");
const dialogContentEl = document.getElementById("syncDialogContent");
const startButton = document.getElementById("startSyncBtn");
const joinButton = document.getElementById("joinSyncBtn");

const DEVICE_ID_KEY = "crottySyncDeviceId";
const LINK_CODE_KEY = "crottySyncLinkCode";
const MIGRATED_KEY = "crottySyncMigrated";
const FAILED_ATTEMPTS_KEY = "crottySyncFailedAttempts";
const LOCK_UNTIL_KEY = "crottySyncLockUntil";
const DEVICE_ID = localStorage.getItem(DEVICE_ID_KEY) || randomCode(20);
localStorage.setItem(DEVICE_ID_KEY, DEVICE_ID);

let auth = null;
let db = null;
let currentUser = null;
let unsubscribeRecords = null;
let applyingCloud = false;
let syncing = false;
let latestCloudMap = new Map();

startButton.addEventListener("click", showCreateDialog);
joinButton.addEventListener("click", showJoinDialog);
window.addEventListener("crotty-records-changed", () => {
  if (!applyingCloud && currentUser) syncLocalChanges();
});
window.addEventListener("online", () => currentUser && setStatus("online", "同期中"));
window.addEventListener("offline", () => setStatus("offline", "オフライン"));

if (!CROTTY_FIREBASE_CONFIG) {
  setStatus("idle", "準備中");
  descriptionEl.textContent = "データ連携のクラウド設定後に利用できます。勤務記録はこれまでどおり端末内へ保存されます。";
  startButton.disabled = true;
  joinButton.disabled = true;
} else {
  initializeSync();
}

async function initializeSync() {
  try {
    const app = initializeApp(CROTTY_FIREBASE_CONFIG);
    auth = getAuth(app);
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    await setPersistence(auth, browserLocalPersistence);
    onAuthStateChanged(auth, user => {
      currentUser = user;
      if (user) beginCloudSync();
      else showDisconnected();
    });
  } catch (error) {
    console.error("同期の初期化に失敗しました", error);
    setStatus("error", "接続エラー");
    descriptionEl.textContent = "データ連携を開始できませんでした。勤務記録は端末内へ保存されています。";
  }
}

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => alphabet[value % alphabet.length]).join("");
}

function normalizeLinkCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}

function accountEmail(linkCode) {
  return `crotty.${linkCode.toLowerCase()}@users.invalid`;
}

function accountPassword(linkCode, pin) {
  return `Cr!${linkCode}!${pin}`;
}

function readRecords() {
  try {
    const records = JSON.parse(localStorage.getItem("records") || "[]");
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function writeRecords(records) {
  applyingCloud = true;
  localStorage.setItem("records", JSON.stringify(records));
  window.loadData?.();
  applyingCloud = false;
}

function cleanRecord(record) {
  const { _syncRevision, _syncUpdatedAt, _syncDeviceId, ...content } = record;
  return content;
}

function recordFingerprint(record) {
  const content = cleanRecord(record);
  return JSON.stringify(Object.keys(content).sort().reduce((result, key) => {
    result[key] = content[key];
    return result;
  }, {}));
}

function cloudRecordFromSnapshot(snapshot) {
  const data = snapshot.data();
  return {
    ...data.content,
    _syncRevision: data.revision || 1,
    _syncUpdatedAt: data.updatedAt || 0,
    _syncDeviceId: data.deviceId || "",
  };
}

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function closeDialog() {
  if (dialogEl.open) dialogEl.close();
}

function dialogTemplate(title, body, actions) {
  dialogContentEl.innerHTML = `<h2>${title}</h2>${body}<div class="sync-dialog-actions">${actions}</div>`;
  dialogEl.showModal();
  dialogContentEl.querySelector("[data-close]")?.addEventListener("click", closeDialog);
}

function showCreateDialog() {
  const linkCode = randomCode(12);
  dialogTemplate(
    "データ連携を始める",
    `<p>この端末の勤務データを連携元にします。</p>
     <label for="createPin">4桁PIN</label>
     <input class="pin-input" id="createPin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="new-password">
     <p class="sync-help">推測されやすい「0000」「1234」や誕生日は避けてください。</p>`,
    `<button type="button" id="createSyncAccount">連携を作成</button>
     <button type="button" class="secondary" data-close>キャンセル</button>`
  );
  document.getElementById("createSyncAccount").addEventListener("click", () => createSyncAccount(linkCode));
  document.getElementById("createPin").focus();
}

async function createSyncAccount(linkCode) {
  const pin = document.getElementById("createPin").value;
  if (!/^\d{4}$/.test(pin)) {
    alert("4桁の数字を入力してください");
    return;
  }
  if (["0000", "1111", "1234", "1212", "7777"].includes(pin)) {
    alert("推測されにくい4桁PINを設定してください");
    return;
  }
  setDialogBusy(true);
  try {
    const credential = await createUserWithEmailAndPassword(auth, accountEmail(linkCode), accountPassword(linkCode, pin));
    localStorage.setItem(LINK_CODE_KEY, linkCode);
    localStorage.setItem(MIGRATED_KEY, credential.user.uid);
    await uploadAllRecords(readRecords(), true);
    closeDialog();
    showRecoveryDialog(linkCode, pin);
  } catch (error) {
    console.error("連携作成に失敗しました", error);
    alert(firebaseErrorMessage(error));
    setDialogBusy(false);
  }
}

function showJoinDialog() {
  const lockUntil = Number(localStorage.getItem(LOCK_UNTIL_KEY) || 0);
  if (lockUntil > Date.now()) {
    const minutes = Math.ceil((lockUntil - Date.now()) / 60000);
    alert(`PINの入力を一時停止しています。約${minutes}分後にお試しください。`);
    return;
  }
  dialogTemplate(
    "別端末を連携",
    `<label for="joinCode">連携コード</label>
     <input id="joinCode" type="text" inputmode="text" maxlength="14" autocomplete="off" placeholder="ABCD-EFGH-JKLM">
     <label for="joinPin">4桁PIN</label>
     <input class="pin-input" id="joinPin" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="current-password">
     <p class="sync-help">連携元の端末に表示されたコードとPINを入力してください。</p>`,
    `<button type="button" id="joinSyncAccount">連携する</button>
     <button type="button" class="secondary" data-close>キャンセル</button>`
  );
  document.getElementById("joinSyncAccount").addEventListener("click", joinSyncAccount);
  document.getElementById("joinCode").focus();
}

async function joinSyncAccount() {
  const linkCode = normalizeLinkCode(document.getElementById("joinCode").value);
  const pin = document.getElementById("joinPin").value;
  if (linkCode.length !== 12 || !/^\d{4}$/.test(pin)) {
    alert("連携コードと4桁PINを確認してください");
    return;
  }
  setDialogBusy(true);
  try {
    await signInWithEmailAndPassword(auth, accountEmail(linkCode), accountPassword(linkCode, pin));
    localStorage.setItem(LINK_CODE_KEY, linkCode);
    clearFailedAttempts();
    closeDialog();
  } catch (error) {
    registerFailedAttempt();
    console.error("端末連携に失敗しました", error);
    alert("連携コードまたはPINが違います");
    setDialogBusy(false);
  }
}

function setDialogBusy(busy) {
  dialogContentEl.querySelectorAll("button,input").forEach(element => element.disabled = busy);
}

function registerFailedAttempt() {
  const attempts = Number(localStorage.getItem(FAILED_ATTEMPTS_KEY) || 0) + 1;
  localStorage.setItem(FAILED_ATTEMPTS_KEY, String(attempts));
  if (attempts >= 5) {
    localStorage.setItem(LOCK_UNTIL_KEY, String(Date.now() + 5 * 60 * 1000));
    localStorage.setItem(FAILED_ATTEMPTS_KEY, "0");
  }
}

function clearFailedAttempts() {
  localStorage.removeItem(FAILED_ATTEMPTS_KEY);
  localStorage.removeItem(LOCK_UNTIL_KEY);
}

function showRecoveryDialog(linkCode, pin) {
  const formattedCode = linkCode.match(/.{1,4}/g).join("-");
  const recoveryCode = `CR-${formattedCode}-${pin}`;
  dialogTemplate(
    "連携を作成しました",
    `<p>復旧コードを安全な場所へ控えてください。この画面を閉じると再表示できません。</p>
     <div class="sync-code">${recoveryCode}</div>
     <canvas id="syncQrCanvas" aria-label="端末連携用QRコード"></canvas>
     <p class="sync-help">QRコードには連携コードとPINが含まれます。他人に見せないでください。</p>`,
    `<button type="button" id="copyRecoveryCode">復旧コードをコピー</button>
     <button type="button" class="secondary" data-close>控えました</button>`
  );
  document.getElementById("copyRecoveryCode").addEventListener("click", async () => {
    await navigator.clipboard.writeText(recoveryCode);
    document.getElementById("copyRecoveryCode").textContent = "コピーしました";
  });
  const qrPayload = `crotty://link?code=${linkCode}&pin=${pin}`;
  if (window.QRCode?.toCanvas) {
    window.QRCode.toCanvas(document.getElementById("syncQrCanvas"), qrPayload, { width: 210, margin: 1 });
  }
}

async function beginCloudSync() {
  setStatus(navigator.onLine ? "online" : "offline", navigator.onLine ? "同期中" : "オフライン");
  descriptionEl.textContent = "この端末は連携済みです。変更は自動的に同期されます。";
  actionsEl.innerHTML = `<button type="button" id="showLinkCodeBtn">連携コードを表示</button><button type="button" class="secondary" id="disconnectSyncBtn">この端末の連携を解除</button>`;
  document.getElementById("showLinkCodeBtn").addEventListener("click", showStoredLinkCode);
  document.getElementById("disconnectSyncBtn").addEventListener("click", confirmDisconnect);

  const recordsCollection = collection(db, "users", currentUser.uid, "records");
  const initialSnapshot = await getDocs(recordsCollection);
  latestCloudMap = new Map(initialSnapshot.docs.map(item => [String(item.id), cloudRecordFromSnapshot(item)]));
  await resolveInitialData(Array.from(latestCloudMap.values()));

  unsubscribeRecords?.();
  unsubscribeRecords = onSnapshot(recordsCollection, snapshot => {
    latestCloudMap = new Map(snapshot.docs.map(item => [String(item.id), cloudRecordFromSnapshot(item)]));
    if (!syncing) {
      writeRecords(Array.from(latestCloudMap.values()).sort(sortRecords));
      setStatus(navigator.onLine ? "online" : "offline", navigator.onLine ? "同期済み" : "オフライン");
    }
  }, error => {
    console.error("同期監視に失敗しました", error);
    setStatus("error", "同期エラー");
  });
}

async function resolveInitialData(cloudRecords) {
  const localRecords = readRecords();
  const migrationDone = localStorage.getItem(MIGRATED_KEY) === currentUser.uid;
  if (migrationDone) {
    if (!cloudRecords.length && localRecords.length) await uploadAllRecords(localRecords, true);
    else if (cloudRecords.length) writeRecords(cloudRecords.sort(sortRecords));
    return;
  }
  if (localRecords.length && cloudRecords.length) {
    await showMigrationChoice(localRecords, cloudRecords);
  } else if (localRecords.length) {
    await uploadAllRecords(localRecords, true);
  } else {
    writeRecords(cloudRecords.sort(sortRecords));
  }
  localStorage.setItem(MIGRATED_KEY, currentUser.uid);
}

function showMigrationChoice(localRecords, cloudRecords) {
  return new Promise(resolve => {
    dialogTemplate(
      "既存データが見つかりました",
      `<p>この端末に${localRecords.length}件、連携先に${cloudRecords.length}件あります。処理方法を選んでください。</p>
       <p class="sync-help">処理前の端末データは自動バックアップとして保持します。</p>`,
      `<button type="button" id="mergeRecordsBtn">両方を統合する</button>
       <button type="button" class="danger" id="preferDeviceBtn">この端末を優先する</button>`
    );
    localStorage.setItem(`crottyPreMigrationBackup:${Date.now()}`, JSON.stringify(localRecords));
    document.getElementById("mergeRecordsBtn").addEventListener("click", async () => {
      setDialogBusy(true);
      const merged = mergeRecords(localRecords, cloudRecords);
      await uploadAllRecords(merged, true);
      writeRecords(merged.sort(sortRecords));
      closeDialog();
      resolve();
    });
    document.getElementById("preferDeviceBtn").addEventListener("click", async () => {
      setDialogBusy(true);
      await uploadAllRecords(localRecords, true);
      writeRecords(localRecords.sort(sortRecords));
      closeDialog();
      resolve();
    });
  });
}

function mergeRecords(localRecords, cloudRecords) {
  const merged = new Map();
  cloudRecords.forEach(record => merged.set(String(record.id), record));
  localRecords.forEach(record => merged.set(String(record.id), record));
  return Array.from(merged.values());
}

async function uploadAllRecords(records, replaceCloud) {
  if (!currentUser) return;
  syncing = true;
  try {
    const recordsCollection = collection(db, "users", currentUser.uid, "records");
    const cloudSnapshot = await getDocs(recordsCollection);
    const batch = writeBatch(db);
    if (replaceCloud) cloudSnapshot.docs.forEach(item => batch.delete(item.ref));
    const now = Date.now();
    records.forEach(record => {
      const recordId = String(record.id || `${record.date}-${randomCode(6)}`);
      batch.set(doc(recordsCollection, recordId), {
        content: cleanRecord({ ...record, id: record.id || recordId }),
        revision: Number(record._syncRevision || 0) + 1,
        updatedAt: now,
        deviceId: DEVICE_ID,
      });
    });
    await batch.commit();
  } finally {
    syncing = false;
  }
}

async function syncLocalChanges() {
  if (syncing || !currentUser || !navigator.onLine) return;
  syncing = true;
  setStatus("online", "同期中");
  try {
    const localRecords = readRecords();
    const localMap = new Map(localRecords.map(record => [String(record.id), record]));
    const recordsCollection = collection(db, "users", currentUser.uid, "records");
    const cloudSnapshot = await getDocs(recordsCollection);
    const cloudMap = new Map(cloudSnapshot.docs.map(item => [String(item.id), cloudRecordFromSnapshot(item)]));
    const conflicts = [];

    for (const [recordId, localRecord] of localMap) {
      const cloudRecord = cloudMap.get(recordId);
      if (!cloudRecord) {
        await setDoc(doc(recordsCollection, recordId), {
          content: cleanRecord(localRecord), revision: 1, updatedAt: Date.now(), deviceId: DEVICE_ID,
        });
        continue;
      }
      if (recordFingerprint(localRecord) === recordFingerprint(cloudRecord)) continue;
      if (Number(localRecord._syncRevision || 0) !== Number(cloudRecord._syncRevision || 0)) {
        conflicts.push({ recordId, localRecord, cloudRecord });
        continue;
      }
      await setDoc(doc(recordsCollection, recordId), {
        content: cleanRecord(localRecord),
        revision: Number(cloudRecord._syncRevision || 0) + 1,
        updatedAt: Date.now(),
        deviceId: DEVICE_ID,
      });
    }

    for (const [recordId, cloudRecord] of cloudMap) {
      if (localMap.has(recordId)) continue;
      const knownCloudRecord = latestCloudMap.get(recordId);
      if (knownCloudRecord && knownCloudRecord._syncRevision === cloudRecord._syncRevision) {
        await deleteDoc(doc(recordsCollection, recordId));
      }
    }

    if (conflicts.length) await showConflictChoice(conflicts);
    setStatus("online", "同期済み");
  } catch (error) {
    console.error("データ同期に失敗しました", error);
    setStatus("error", "同期エラー");
  } finally {
    syncing = false;
  }
}

function showConflictChoice(conflicts) {
  return new Promise(resolve => {
    dialogTemplate(
      "同時変更を確認",
      `<p>${conflicts.length}件の記録がスマホとPCの両方で変更されています。</p>`,
      `<button type="button" id="preferLocalConflictBtn">この端末を優先する</button>
       <button type="button" class="secondary" id="preferCloudConflictBtn">連携先を優先する</button>`
    );
    document.getElementById("preferLocalConflictBtn").addEventListener("click", async () => {
      setDialogBusy(true);
      for (const conflict of conflicts) {
        await setDoc(doc(db, "users", currentUser.uid, "records", conflict.recordId), {
          content: cleanRecord(conflict.localRecord),
          revision: Number(conflict.cloudRecord._syncRevision || 0) + 1,
          updatedAt: Date.now(), deviceId: DEVICE_ID,
        });
      }
      closeDialog();
      resolve();
    });
    document.getElementById("preferCloudConflictBtn").addEventListener("click", () => {
      const records = readRecords();
      const conflictMap = new Map(conflicts.map(item => [item.recordId, item.cloudRecord]));
      writeRecords(records.map(record => conflictMap.get(String(record.id)) || record));
      closeDialog();
      resolve();
    });
  });
}

function showStoredLinkCode() {
  const linkCode = localStorage.getItem(LINK_CODE_KEY);
  if (!linkCode) {
    alert("この端末には連携コードが保存されていません。復旧コードをご利用ください。");
    return;
  }
  const formattedCode = linkCode.match(/.{1,4}/g).join("-");
  codeDisplayEl.hidden = false;
  codeDisplayEl.textContent = `連携コード: ${formattedCode}`;
}

function confirmDisconnect() {
  dialogTemplate(
    "この端末の連携を解除",
    `<p>この端末に保存済みの勤務記録は残ります。クラウド側や他の端末のデータは削除されません。</p>`,
    `<button type="button" class="danger" id="disconnectConfirmBtn">連携を解除する</button>
     <button type="button" class="secondary" data-close>キャンセル</button>`
  );
  document.getElementById("disconnectConfirmBtn").addEventListener("click", async () => {
    await signOut(auth);
    localStorage.removeItem(LINK_CODE_KEY);
    localStorage.removeItem(MIGRATED_KEY);
    unsubscribeRecords?.();
    closeDialog();
  });
}

function showDisconnected() {
  setStatus("idle", "未連携");
  descriptionEl.textContent = "スマホとPCで、自分の勤務データを同期できます。";
  actionsEl.innerHTML = `<button type="button" id="startSyncBtn2">連携を始める</button><button type="button" class="secondary" id="joinSyncBtn2">別端末を連携</button>`;
  document.getElementById("startSyncBtn2").addEventListener("click", showCreateDialog);
  document.getElementById("joinSyncBtn2").addEventListener("click", showJoinDialog);
  codeDisplayEl.hidden = true;
}

function sortRecords(a, b) {
  return String(b.date || "").localeCompare(String(a.date || "")) || Number(b.id || 0) - Number(a.id || 0);
}

function firebaseErrorMessage(error) {
  const code = String(error?.code || "");
  if (code.includes("email-already-in-use")) return "同じ連携コードが既に存在します。もう一度作成してください。";
  if (code.includes("network-request-failed")) return "通信できません。インターネット接続を確認してください。";
  return "データ連携を開始できませんでした。しばらくしてからもう一度お試しください。";
}
