let currentGroup = null;
let categoryChart = null;
let monthChart = null;
let memberChart = null;
let editingTxnId = null;

const ICON_PENCIL =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_RECEIPT =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/><path d="M9 9h1"/><path d="M9 13h6"/><path d="M9 17h6"/></svg>';

// ---------------------------------------------------------------------
// Generic modal (rename dialogs, receipt preview)
// ---------------------------------------------------------------------
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalCancelBtn = document.getElementById("modalCancelBtn");
const modalConfirmBtn = document.getElementById("modalConfirmBtn");
let modalOnConfirm = null;

function openModal({ title, bodyHtml, confirmText = "Save", onConfirm, hideConfirm = false }) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalConfirmBtn.textContent = confirmText;
  modalConfirmBtn.classList.toggle("hidden", hideConfirm);
  modalOnConfirm = onConfirm;
  modalOverlay.classList.remove("hidden");
  const firstInput = modalBody.querySelector("input");
  if (firstInput) {
    firstInput.focus();
    firstInput.select();
  }
}

function closeModal() {
  modalOverlay.classList.add("hidden");
  modalOnConfirm = null;
}

modalCancelBtn.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
modalConfirmBtn.addEventListener("click", async () => {
  if (modalOnConfirm) {
    try {
      await modalOnConfirm();
      closeModal();
    } catch (err) {
      alert(err.message);
    }
  }
});
modalBody.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    modalConfirmBtn.click();
  }
});

// ---------------------------------------------------------------------
// Auth wiring
// ---------------------------------------------------------------------
function showAuthed(email) {
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("userBar").classList.remove("hidden");
  document.getElementById("userEmail").textContent = email;
  loadGroups();
}

function showAuthError(err) {
  document.getElementById("authError").textContent = err.message || String(err);
}

document.getElementById("showSignUp").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("signInForm").classList.add("hidden");
  document.getElementById("signUpForm").classList.remove("hidden");
});

document.getElementById("signInForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("signInEmail").value;
  const password = document.getElementById("signInPassword").value;
  try {
    await Auth.signIn(email, password);
    showAuthed(email);
  } catch (err) {
    showAuthError(err);
  }
});

document.getElementById("signUpForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("signUpEmail").value;
  const password = document.getElementById("signUpPassword").value;
  try {
    // Accounts are auto-confirmed server-side (Cognito Pre Sign-up trigger),
    // so sign in immediately instead of asking for an emailed code.
    await Auth.signUp(email, password);
    await Auth.signIn(email, password);
    showAuthed(email);
  } catch (err) {
    showAuthError(err);
  }
});

document.getElementById("signOutBtn").addEventListener("click", () => {
  Auth.signOut();
  window.location.reload();
});

document.getElementById("changePasswordBtn").addEventListener("click", () => {
  openModal({
    title: "Change password",
    bodyHtml: `
      <input type="password" id="modalOldPassword" placeholder="Current password" autocomplete="current-password" />
      <input type="password" id="modalNewPassword" placeholder="New password" minlength="8" autocomplete="new-password" />
      <p class="hint">At least 8 characters, including a lowercase letter and a number. Must be different from your current password.</p>
    `,
    confirmText: "Change password",
    onConfirm: async () => {
      const oldPassword = document.getElementById("modalOldPassword").value;
      const newPassword = document.getElementById("modalNewPassword").value;
      if (!oldPassword || !newPassword) throw new Error("Both fields are required");
      if (newPassword === oldPassword) {
        throw new Error("New password must be different from your current password");
      }
      if (newPassword.length < 8 || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
        throw new Error("New password must be at least 8 characters and include a lowercase letter and a number");
      }
      try {
        await Auth.changePassword(oldPassword, newPassword);
      } catch (err) {
        if (err.code === "InvalidPasswordException") {
          throw new Error("New password doesn't meet the requirements above");
        }
        if (err.code === "NotAuthorizedException") {
          throw new Error("Current password is incorrect");
        }
        throw err;
      }
      await Api.markPasswordChanged();
      alert("Password changed successfully.");
    },
  });
});

// ---------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------
async function loadGroups() {
  const { groups } = await Api.listGroups();
  const list = document.getElementById("groupList");
  list.innerHTML = "";
  if (groups.length === 0) {
    list.innerHTML = '<li class="sidebar-empty">No groups yet — create one below.</li>';
    return;
  }
  groups.forEach((g) => {
    const li = document.createElement("li");
    li.textContent = g.name;
    li.dataset.groupId = g.group_id;
    li.dataset.groupName = g.name;
    if (currentGroup && currentGroup.group_id === g.group_id) li.classList.add("active");
    li.addEventListener("click", () => selectGroup(g.group_id));
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showGroupContextMenu(e.clientX, e.clientY, g.group_id, g.name);
    });
    list.appendChild(li);
  });
}

document.getElementById("newGroupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("newGroupName").value;
  const currency = document.getElementById("newGroupCurrency").value;
  const { group_id } = await Api.createGroup(name, [], currency);
  document.getElementById("newGroupName").value = "";
  await loadGroups();
  selectGroup(group_id);
});

async function selectGroup(groupId) {
  currentGroup = await Api.getGroup(groupId);
  document.querySelectorAll("#groupList li").forEach((li) => {
    li.classList.toggle("active", li.dataset.groupId === groupId);
  });
  document.getElementById("noGroupSelected").classList.add("hidden");
  document.getElementById("groupPanel").classList.remove("hidden");
  document.getElementById("groupTitle").textContent = currentGroup.name;
  document.getElementById("groupBaseCurrency").textContent =
    `Base currency: ${currentGroup.base_currency || "USD"}`;
  resetTxnForm();
  document.getElementById("reportsContent").classList.add("hidden");
  document.getElementById("reportsEmpty").classList.remove("hidden");
  await refreshTransactions();
  await refreshBalances();
}

document.getElementById("renameGroupBtn").addEventListener("click", () => {
  openModal({
    title: "Rename group",
    bodyHtml: `<input type="text" id="modalGroupName" value="${escapeHtml(currentGroup.name)}" />`,
    confirmText: "Save",
    onConfirm: async () => {
      const name = document.getElementById("modalGroupName").value.trim();
      if (!name) throw new Error("Group name is required");
      await Api.renameGroup(currentGroup.group_id, name);
      currentGroup.name = name;
      document.getElementById("groupTitle").textContent = name;
      await loadGroups();
    },
  });
});

// ---------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------
function renderMembers() {
  const list = document.getElementById("memberList");
  list.innerHTML = "";
  currentGroup.members.forEach((m) => {
    const li = document.createElement("li");
    li.className = "member-row";
    li.innerHTML = `
      <span>${escapeHtml(m)}</span>
      <span class="member-actions">
        <button type="button" class="icon-btn" data-action="rename" title="Rename">${ICON_PENCIL}</button>
        <button type="button" class="danger-btn" data-action="remove" title="Remove">Remove</button>
      </span>`;
    li.querySelector('[data-action="rename"]').addEventListener("click", () => renameMemberPrompt(m));
    li.querySelector('[data-action="remove"]').addEventListener("click", () => removeMemberPrompt(m));
    list.appendChild(li);
  });

  const payerSelect = document.getElementById("txnPayer");
  payerSelect.innerHTML = currentGroup.members
    .map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`)
    .join("");

  const splitGroup = document.getElementById("txnSplitAmong");
  splitGroup.innerHTML = currentGroup.members
    .map(
      (m) => `<label><input type="checkbox" value="${escapeAttr(m)}" checked /> ${escapeHtml(m)}</label>`
    )
    .join("");
}

document.getElementById("addMemberForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("newMemberName").value;
  const { members } = await Api.addMember(currentGroup.group_id, name);
  currentGroup.members = members;
  document.getElementById("newMemberName").value = "";
  renderMembers();
});

function renameMemberPrompt(oldName) {
  openModal({
    title: `Rename "${oldName}"`,
    bodyHtml: `<input type="text" id="modalMemberName" value="${escapeAttr(oldName)}" />`,
    confirmText: "Save",
    onConfirm: async () => {
      const newName = document.getElementById("modalMemberName").value.trim();
      if (!newName) throw new Error("Member name is required");
      const { members } = await Api.renameMember(currentGroup.group_id, oldName, newName);
      currentGroup.members = members;
      renderMembers();
      await refreshTransactions();
      await refreshBalances();
    },
  });
}

async function removeMemberPrompt(name) {
  if (!confirm(`Remove "${name}" from this group?`)) return;
  try {
    const { members } = await Api.removeMember(currentGroup.group_id, name);
    currentGroup.members = members;
    renderMembers();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

// ---------------------------------------------------------------------
// Right-click context menu for group list items
// ---------------------------------------------------------------------
const groupContextMenu = document.getElementById("groupContextMenu");
let contextMenuGroupId = null;
let contextMenuGroupName = null;

function showGroupContextMenu(x, y, groupId, groupName) {
  contextMenuGroupId = groupId;
  contextMenuGroupName = groupName;
  groupContextMenu.style.left = `${x}px`;
  groupContextMenu.style.top = `${y}px`;
  groupContextMenu.classList.remove("hidden");
}

function hideGroupContextMenu() {
  groupContextMenu.classList.add("hidden");
  contextMenuGroupId = null;
  contextMenuGroupName = null;
}

document.addEventListener("click", hideGroupContextMenu);
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("#groupList li")) hideGroupContextMenu();
});

groupContextMenu.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (action === "delete" && contextMenuGroupId) {
    if (confirm(`Delete "${contextMenuGroupName}"? This removes all its transactions too.`)) {
      await Api.deleteGroup(contextMenuGroupId);
      if (currentGroup && currentGroup.group_id === contextMenuGroupId) {
        currentGroup = null;
        document.getElementById("groupPanel").classList.add("hidden");
        document.getElementById("noGroupSelected").classList.remove("hidden");
      }
      await loadGroups();
    }
  }
});

document.getElementById("deleteGroupBtn").addEventListener("click", async () => {
  if (!confirm(`Delete "${currentGroup.name}"? This removes all its transactions too.`)) {
    return;
  }
  await Api.deleteGroup(currentGroup.group_id);
  currentGroup = null;
  document.getElementById("groupPanel").classList.add("hidden");
  document.getElementById("noGroupSelected").classList.remove("hidden");
  await loadGroups();
});

// ---------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------
function resetTxnForm() {
  editingTxnId = null;
  document.getElementById("addTxnForm").reset();
  document.getElementById("txnFormTitle").textContent = "Add a transaction";
  document.getElementById("txnSubmitBtn").textContent = "Add transaction";
  document.getElementById("cancelEditTxnBtn").classList.add("hidden");
  if (currentGroup) {
    document.getElementById("txnCurrency").value = currentGroup.base_currency || "USD";
  }
  document.getElementById("txnDate").value = new Date().toISOString().slice(0, 10);
  renderMembers();
}

document.getElementById("cancelEditTxnBtn").addEventListener("click", resetTxnForm);

document.getElementById("addTxnForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payer = document.getElementById("txnPayer").value;
  const amount = parseFloat(document.getElementById("txnAmount").value);
  const currency = document.getElementById("txnCurrency").value;
  const date = document.getElementById("txnDate").value;
  const description = document.getElementById("txnDescription").value;
  const category = document.getElementById("txnCategory").value;
  const splitAmong = Array.from(
    document.querySelectorAll("#txnSplitAmong input:checked")
  ).map((cb) => cb.value);
  const fileInput = document.getElementById("txnReceipt");

  if (splitAmong.length === 0) {
    alert("Select at least one member to split this transaction among.");
    return;
  }
  if (!amount || amount <= 0) {
    alert("Enter a valid amount.");
    return;
  }

  try {
    let receiptKey = editingTxnId ? undefined : null;
    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const { upload_url, key } = await Api.getReceiptUploadUrl(currentGroup.group_id, file.type);
      await Api.uploadReceipt(upload_url, file);
      receiptKey = key;
    }

    const payload = {
      payer,
      amount,
      currency,
      date,
      description,
      category,
      split_among: splitAmong,
    };
    if (receiptKey !== undefined) payload.receipt_key = receiptKey;

    if (editingTxnId) {
      await Api.updateTransaction(currentGroup.group_id, editingTxnId, payload);
    } else {
      await Api.addTransaction(currentGroup.group_id, payload);
    }

    resetTxnForm();
    await refreshTransactions();
    await refreshBalances();
  } catch (err) {
    alert(err.message);
  }
});

function startEditTxn(txn) {
  editingTxnId = txn.txn_id;
  document.getElementById("txnFormTitle").textContent = "Edit transaction";
  document.getElementById("txnSubmitBtn").textContent = "Save changes";
  document.getElementById("cancelEditTxnBtn").classList.remove("hidden");

  document.getElementById("txnPayer").value = txn.payer;
  document.getElementById("txnAmount").value = txn.original_amount ?? txn.amount;
  document.getElementById("txnCurrency").value = txn.currency || currentGroup.base_currency || "USD";
  document.getElementById("txnDate").value = (txn.created_at || "").slice(0, 10);
  document.getElementById("txnDescription").value = txn.description || "";
  document.getElementById("txnCategory").value = txn.category;
  document.querySelectorAll("#txnSplitAmong input").forEach((cb) => {
    cb.checked = txn.split_among.includes(cb.value);
  });
  document.getElementById("addTxnForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteTxn(txnId) {
  if (!confirm("Delete this transaction?")) return;
  await Api.deleteTransaction(currentGroup.group_id, txnId);
  if (editingTxnId === txnId) resetTxnForm();
  await refreshTransactions();
  await refreshBalances();
}

async function previewReceipt(receiptKey) {
  const { view_url } = await Api.getReceiptViewUrl(receiptKey);
  openModal({
    title: "Receipt",
    bodyHtml: `<img src="${view_url}" alt="Receipt" />`,
    hideConfirm: true,
  });
}

let allTransactions = [];

async function refreshTransactions() {
  const { transactions } = await Api.listTransactions(currentGroup.group_id);
  allTransactions = transactions;
  populateCategoryFilter();
  populatePersonFilter();
  populateReportsPersonFilter();
  renderTransactionList();
}

function populateCategoryFilter() {
  const select = document.getElementById("txnFilterCategory");
  const current = select.value;
  const categories = Array.from(new Set(allTransactions.map((t) => t.category))).sort();
  select.innerHTML =
    '<option value="">All categories</option>' +
    categories.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
  if (categories.includes(current)) select.value = current;
}

function populatePersonFilter() {
  const select = document.getElementById("txnFilterPerson");
  const current = select.value;
  const people = Array.from(
    new Set(allTransactions.flatMap((t) => [t.payer, t.payee]).filter(Boolean))
  ).sort();
  select.innerHTML =
    '<option value="">All people</option>' +
    people.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
  if (people.includes(current)) select.value = current;
}

function renderTransactionList() {
  const list = document.getElementById("txnList");
  const categoryFilter = document.getElementById("txnFilterCategory").value;
  const personFilter = document.getElementById("txnFilterPerson").value;
  const dateFrom = document.getElementById("txnFilterDateFrom").value;
  const dateTo = document.getElementById("txnFilterDateTo").value;
  const sortBy = document.getElementById("txnSortBy").value;

  let transactions = allTransactions;
  if (categoryFilter) {
    transactions = transactions.filter((t) => t.category === categoryFilter);
  }
  if (personFilter) {
    transactions = transactions.filter((t) => t.payer === personFilter || t.payee === personFilter);
  }
  if (dateFrom) {
    transactions = transactions.filter((t) => t.created_at.slice(0, 10) >= dateFrom);
  }
  if (dateTo) {
    transactions = transactions.filter((t) => t.created_at.slice(0, 10) <= dateTo);
  }
  transactions = [...transactions].sort((a, b) => {
    if (sortBy === "date_asc") return new Date(a.created_at) - new Date(b.created_at);
    if (sortBy === "date_desc") return new Date(b.created_at) - new Date(a.created_at);
    if (sortBy === "amount_asc") return a.amount - b.amount;
    if (sortBy === "amount_desc") return b.amount - a.amount;
    return 0;
  });

  list.innerHTML = "";
  if (transactions.length === 0) {
    list.innerHTML = '<p class="hint">No transactions match this filter.</p>';
    return;
  }

  const baseCurrency = currentGroup.base_currency || "USD";

  transactions.forEach((t) => {
    const card = document.createElement("div");
    card.className = "txn-card";

    const currency = t.currency || baseCurrency;
    const originalAmount = t.original_amount ?? t.amount;
    const amountLabel =
      currency !== baseCurrency
        ? `${formatMoney(originalAmount)} ${currency} <span class="txn-meta">(≈ ${formatMoney(t.amount)} ${baseCurrency})</span>`
        : `${formatMoney(t.amount)} ${baseCurrency}`;

    const headline = t.is_settlement
      ? `${escapeHtml(t.payer)} settled up with ${escapeHtml(t.payee)}: ${amountLabel}`
      : `${escapeHtml(t.payer)} paid ${amountLabel}`;
    const categoryTag = t.is_settlement
      ? '<span class="settlement-badge">Settlement</span>'
      : `<span class="txn-category-badge">${escapeHtml(t.category)}</span>`;
    const metaLine = t.is_settlement
      ? `${escapeHtml(t.description || "Payment recorded")} · ${new Date(t.created_at).toLocaleString()}`
      : `${escapeHtml(t.description || "No description")} · ${new Date(t.created_at).toLocaleString()} · split among ${t.split_among.length}`;

    card.innerHTML = `
      <div class="txn-main">
        <div>
          <span class="txn-amount">${headline}</span>
          ${categoryTag}
        </div>
        <div class="txn-meta">${metaLine}</div>
      </div>
      <div class="txn-actions">
        ${t.receipt_key ? `<button type="button" class="receipt-btn" data-action="receipt">${ICON_RECEIPT} Receipt</button>` : ""}
        ${t.is_settlement ? "" : '<button type="button" class="secondary-btn" data-action="edit">Edit</button>'}
        <button type="button" class="danger-btn" data-action="delete">Delete</button>
      </div>`;

    if (t.receipt_key) {
      card.querySelector('[data-action="receipt"]').addEventListener("click", () => previewReceipt(t.receipt_key));
    }
    if (!t.is_settlement) {
      card.querySelector('[data-action="edit"]').addEventListener("click", () => startEditTxn(t));
    }
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteTxn(t.txn_id));

    list.appendChild(card);
  });
}

document.getElementById("txnFilterCategory").addEventListener("change", renderTransactionList);
document.getElementById("txnFilterPerson").addEventListener("change", renderTransactionList);
document.getElementById("txnFilterDateFrom").addEventListener("change", renderTransactionList);
document.getElementById("txnFilterDateTo").addEventListener("change", renderTransactionList);
document.getElementById("txnSortBy").addEventListener("change", renderTransactionList);

// ---------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------
async function refreshBalances() {
  const { balances, settlements } = await Api.getBalances(currentGroup.group_id);
  const baseCurrency = currentGroup.base_currency || "USD";
  const balanceList = document.getElementById("balanceList");
  balanceList.innerHTML = "";
  Object.entries(balances).forEach(([member, amount]) => {
    const li = document.createElement("li");
    if (amount > 0) {
      li.innerHTML = `${escapeHtml(member)} <span class="owed">is owed ${formatMoney(amount)} ${baseCurrency}</span>`;
    } else if (amount < 0) {
      li.innerHTML = `${escapeHtml(member)} <span class="owes">owes ${formatMoney(Math.abs(amount))} ${baseCurrency}</span>`;
    } else {
      li.textContent = `${member} is settled up`;
    }
    balanceList.appendChild(li);
  });

  const settlementList = document.getElementById("settlementList");
  settlementList.innerHTML = "";
  if (settlements.length === 0) {
    settlementList.innerHTML = "<li>Everyone is settled up.</li>";
  }
  settlements.forEach((s) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(s.from)} pays ${escapeHtml(s.to)} ${formatMoney(s.amount)} ${baseCurrency}</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-btn";
    btn.textContent = "Settle up";
    btn.addEventListener("click", () => openSettleUpModal(s.from, s.to, s.amount));
    li.appendChild(btn);
    settlementList.appendChild(li);
  });
}

function openSettleUpModal(from, to, suggestedAmount) {
  const baseCurrency = currentGroup.base_currency || "USD";
  openModal({
    title: "Settle up",
    bodyHtml: `
      <p class="hint">${escapeHtml(from)} pays ${escapeHtml(to)}</p>
      <input type="number" id="modalSettleAmount" value="${suggestedAmount.toFixed(2)}" step="0.01" min="0.01" placeholder="Amount" />
      <p class="hint">Defaults to the full amount owed - lower it to record a partial payment.</p>
      <input type="date" id="modalSettleDate" value="${new Date().toISOString().slice(0, 10)}" title="Date this payment actually happened" />
      <p class="hint">The date the payment actually happened - not the date of the expense being settled.</p>
    `,
    confirmText: "Record payment",
    onConfirm: async () => {
      const amount = parseFloat(document.getElementById("modalSettleAmount").value);
      const date = document.getElementById("modalSettleDate").value;
      if (!amount || amount <= 0) throw new Error("Enter a valid amount");
      await Api.addSettlement(currentGroup.group_id, {
        payer: from,
        payee: to,
        amount,
        currency: baseCurrency,
        date,
      });
      await refreshTransactions();
      await refreshBalances();
    },
  });
}

// ---------------------------------------------------------------------
// Reports (Athena-backed analytics)
// ---------------------------------------------------------------------
// Fixed categorical order (never cycled/regenerated) for identity data
// (category names); a single dusty-purple hue for magnitude comparisons
// (month/member bars), since those are one series, not distinct identities.
const CATEGORICAL_COLORS = ["#7c6baf", "#5e8c6e", "#c76b83", "#c99a44", "#4f8fa6", "#9a7550"];
const SEQUENTIAL_HUE = "#7c6baf";

Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
Chart.defaults.color = "#5b5563";
Chart.defaults.plugins.legend.display = false;

function populateReportsPersonFilter() {
  const select = document.getElementById("reportsFilterPerson");
  const current = select.value;
  const people = Array.from(
    new Set(allTransactions.flatMap((t) => [t.payer, t.payee]).filter(Boolean))
  ).sort();
  select.innerHTML =
    '<option value="">All people</option>' +
    people.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
  if (people.includes(current)) select.value = current;
}

document.getElementById("refreshReportsBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshReportsBtn");
  btn.disabled = true;
  btn.textContent = "Querying Athena...";
  try {
    const member = document.getElementById("reportsFilterPerson").value;
    const dateFrom = document.getElementById("reportsFilterDateFrom").value;
    const dateTo = document.getElementById("reportsFilterDateTo").value;
    const { by_category, by_month, by_member, settlements } = await Api.getReports(currentGroup.group_id, {
      member,
      dateFrom,
      dateTo,
    });
    document.getElementById("reportsEmpty").classList.add("hidden");
    document.getElementById("reportsContent").classList.remove("hidden");
    renderReportStats(by_category, settlements);
    renderCategoryChart(by_category);
    renderMonthChart(by_month);
    renderMemberChart(by_member);
    renderSettlementsReport(settlements);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh analytics (Athena)";
  }
});

function renderReportStats(byCategory, settlements) {
  const baseCurrency = currentGroup.base_currency || "USD";
  const totalSpend = byCategory.reduce((sum, r) => sum + parseFloat(r.total), 0);
  const totalSettled = settlements.reduce((sum, r) => sum + parseFloat(r.total), 0);
  document.getElementById("statTotalSpend").textContent = `${formatMoney(totalSpend)} ${baseCurrency}`;
  document.getElementById("statTotalSettled").textContent = `${formatMoney(totalSettled)} ${baseCurrency}`;
  document.getElementById("statCategoryCount").textContent = byCategory.length;
}

function renderCategoryChart(rows) {
  const ctx = document.getElementById("categoryChart");
  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map((r) => r.category),
      datasets: [
        {
          data: rows.map((r) => parseFloat(r.total)),
          backgroundColor: rows.map((_, i) => CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]),
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      scales: { x: { grid: { color: "#e4dff0" } }, y: { grid: { display: false } } },
      plugins: { tooltip: { enabled: true, callbacks: { label: (ctx) => formatMoney(ctx.parsed.x) } } },
    },
  });
}

function renderMonthChart(rows) {
  const ctx = document.getElementById("monthChart");
  if (monthChart) monthChart.destroy();
  monthChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map((r) => `${r.year}-${r.month}`),
      datasets: [{ data: rows.map((r) => parseFloat(r.total)), backgroundColor: SEQUENTIAL_HUE, borderRadius: 4 }],
    },
    options: {
      scales: { x: { grid: { display: false } }, y: { grid: { color: "#e4dff0" } } },
      plugins: { tooltip: { enabled: true, callbacks: { label: (ctx) => formatMoney(ctx.parsed.y) } } },
    },
  });
}

function renderMemberChart(rows) {
  const ctx = document.getElementById("memberChart");
  if (memberChart) memberChart.destroy();
  memberChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map((r) => r.payer),
      datasets: [{ data: rows.map((r) => parseFloat(r.total)), backgroundColor: SEQUENTIAL_HUE, borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      scales: { x: { grid: { color: "#e4dff0" } }, y: { grid: { display: false } } },
      plugins: { tooltip: { enabled: true, callbacks: { label: (ctx) => formatMoney(ctx.parsed.x) } } },
    },
  });
}

function renderSettlementsReport(rows) {
  const list = document.getElementById("settlementsReportList");
  list.innerHTML = "";
  if (rows.length === 0) {
    list.innerHTML = "<li>No settlements recorded yet.</li>";
    return;
  }
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(r.payer)} &rarr; ${escapeHtml(r.payee)}</span><strong>${formatMoney(r.total)}</strong>`;
    list.appendChild(li);
  });
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}

function formatMoney(amount) {
  return Number(amount).toLocaleString("vi-VN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------
// Bootstrap: resume session if already signed in
// ---------------------------------------------------------------------
(function bootstrap() {
  Auth.currentUserEmail().then((email) => {
    if (email) showAuthed(email);
  });
})();
