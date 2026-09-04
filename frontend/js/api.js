const Api = {
  async _fetch(path, options = {}) {
    const token = await Auth.getIdToken();
    const resp = await fetch(`${window.APP_CONFIG.API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        ...(options.headers || {}),
      },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  },

  createGroup(name, members, baseCurrency) {
    return this._fetch("/groups", {
      method: "POST",
      body: JSON.stringify({ name, members, base_currency: baseCurrency }),
    });
  },
  listGroups() {
    return this._fetch("/groups");
  },
  getGroup(groupId) {
    return this._fetch(`/groups/${groupId}`);
  },
  deleteGroup(groupId) {
    return this._fetch(`/groups/${groupId}`, { method: "DELETE" });
  },
  renameGroup(groupId, name) {
    return this._fetch(`/groups/${groupId}`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  addMember(groupId, name) {
    return this._fetch(`/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ name }) });
  },
  removeMember(groupId, name) {
    return this._fetch(`/groups/${groupId}/members`, { method: "DELETE", body: JSON.stringify({ name }) });
  },
  renameMember(groupId, oldName, newName) {
    return this._fetch(`/groups/${groupId}/members`, {
      method: "PUT",
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
  },
  listTransactions(groupId) {
    return this._fetch(`/groups/${groupId}/transactions`);
  },
  addTransaction(groupId, txn) {
    return this._fetch(`/groups/${groupId}/transactions`, { method: "POST", body: JSON.stringify(txn) });
  },
  addSettlement(groupId, { payer, payee, amount, currency, date }) {
    return this._fetch(`/groups/${groupId}/transactions`, {
      method: "POST",
      body: JSON.stringify({ payer, payee, amount, currency, date, is_settlement: true }),
    });
  },
  updateTransaction(groupId, txnId, txn) {
    return this._fetch(`/groups/${groupId}/transactions/${txnId}`, {
      method: "PUT",
      body: JSON.stringify(txn),
    });
  },
  deleteTransaction(groupId, txnId) {
    return this._fetch(`/groups/${groupId}/transactions/${txnId}`, { method: "DELETE" });
  },
  getBalances(groupId) {
    return this._fetch(`/groups/${groupId}/balances`);
  },
  getReports(groupId, { member, dateFrom, dateTo } = {}) {
    const params = new URLSearchParams();
    if (member) params.set("member", member);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    const qs = params.toString();
    return this._fetch(`/groups/${groupId}/reports${qs ? `?${qs}` : ""}`);
  },
  async getReceiptUploadUrl(groupId, contentType) {
    return this._fetch("/receipts/upload-url", {
      method: "POST",
      body: JSON.stringify({ group_id: groupId, content_type: contentType }),
    });
  },
  async uploadReceipt(uploadUrl, file) {
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!resp.ok) throw new Error("Receipt upload failed");
  },
  getReceiptViewUrl(key) {
    return this._fetch(`/receipts/view-url?key=${encodeURIComponent(key)}`);
  },
  markPasswordChanged() {
    return this._fetch("/account/password-changed", { method: "PUT" });
  },
};
