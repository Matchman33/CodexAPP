// 复用审批卡片区域；答案只经当前连接发送，不写入本地存储或聊天记录。
window.InteractionRequests = class InteractionRequests {
  static pending = new Map();
  static reset() { for (const value of this.pending.values()) clearTimeout(value.timer); this.pending.clear(); }
  static resolved(key) {
    for (const [id, value] of this.pending) if (value.key === key) { clearTimeout(value.timer); this.pending.delete(id); }
  }
  static error(message) {
    const value = this.pending.get(message.requestId);
    if (!value) return false;
    clearTimeout(value.timer); this.pending.delete(message.requestId);
    value.status.textContent = message.message || "提交失败，请重试";
    value.form.querySelectorAll("button").forEach(button => { button.disabled = false; });
    return true;
  }
  static render(card, approval, send) {
    const form = document.createElement("form"); form.className = "interaction-form";
    const status = document.createElement("div"); status.className = "interaction-status"; status.setAttribute("role", "status");
    const actions = card.querySelector(".ac-actions"), readers = [];
    function labelControl(labelText, input, description) {
      const wrap = document.createElement("label"); wrap.className = "interaction-field";
      const title = document.createElement("span"); title.textContent = labelText; wrap.append(title, input);
      if (description) { const help = document.createElement("small"); help.textContent = description; wrap.append(help); }
      form.append(wrap); return input;
    }
    const textInput = secret => { const input = document.createElement("input"); input.type = secret ? "password" : "text"; input.autocomplete = "off"; input.maxLength = 8192; return input; };
    if (approval.kind === "question") {
      for (const q of approval.questions) {
        const section = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = q.question; section.append(legend); form.append(section);
        const choices = [];
        for (const option of q.options || []) {
          const label = document.createElement("label"), radio = document.createElement("input"); radio.type = "radio"; radio.name = approval.key + "-" + q.id; radio.value = option.label;
          const caption = document.createElement("span"); caption.textContent = option.label + (option.description ? " — " + option.description : ""); label.append(radio, caption); section.append(label); choices.push(radio);
        }
        let input;
        if (!choices.length || q.isOther) {
          input = textInput(q.isSecret);
          input.setAttribute("aria-label", choices.length ? q.question + "（其他回答）" : q.question);
          input.placeholder = choices.length ? "其他回答" : "请输入回答";
          input.oninput = () => { if (input.value) choices.forEach(choice => { choice.checked = false; }); };
          choices.forEach(choice => { choice.onchange = () => { input.value = ""; }; });
          section.append(input);
        }
        readers.push(() => {
          const answer = input?.value || choices.find(choice => choice.checked)?.value;
          if (!answer?.trim()) throw new Error("请回答：" + q.question);
          return [q.id, { answers: [answer] }];
        });
      }
    } else if (approval.kind === "form") {
      const schema = approval.schema;
      const fields = Object.entries(schema.properties || {});
      const primitive = schema.type === "object" && fields.length <= 64 && fields.every(([, field]) => ["string", "number", "integer", "boolean"].includes(field.type) && !field.$ref && !field.oneOf && !field.anyOf);
      if (primitive) {
        for (const [name, field] of fields) {
          const required = schema.required?.includes(name);
          let input;
          if (field.enum || field.type === "boolean") {
            input = document.createElement("select");
            input.append(new Option("请选择", ""));
            const options = field.enum || [true, false];
            options.forEach((value, i) => input.append(new Option(field.enumNames?.[i] || (field.type === "boolean" ? value ? "是" : "否" : String(value)), String(value))));
          } else {
            input = textInput(field.format === "password");
            if (["number", "integer"].includes(field.type)) { input.type = "number"; input.step = field.type === "integer" ? "1" : "any"; if (field.minimum != null) input.min = field.minimum; if (field.maximum != null) input.max = field.maximum; }
            else { if (field.maxLength != null) input.maxLength = Math.min(field.maxLength, 8192); if (field.minLength != null) input.minLength = field.minLength; if (field.format === "email") input.type = "email"; if (field.format === "date") input.type = "date"; }
          }
          input.required = !!required;
          input.setAttribute("aria-label", field.title || name);
          if (field.default !== undefined) input.value = String(field.default);
          labelControl(field.title || name, input, field.description);
          readers.push(() => {
            if (!input.value && !required) return null;
            return [name, field.type === "boolean" ? input.value === "true" : ["number", "integer"].includes(field.type) ? Number(input.value) : input.value];
          });
        }
      } else {
        const help = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre"); summary.textContent = "查看表单字段说明"; pre.textContent = JSON.stringify(schema, null, 2); help.append(summary, pre); form.append(help);
        const input = document.createElement("textarea"); input.rows = 5; input.maxLength = 65536; input.required = true; labelControl("表单内容（JSON）", input);
        readers.push(() => JSON.parse(input.value));
      }
      form.dataset.json = primitive ? "false" : "true";
    } else {
      const link = document.createElement("a"); link.textContent = "打开授权页面"; link.href = approval.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.className = "btn secondary"; form.append(link);
      const note = document.createElement("p"); note.textContent = "在授权页面完成操作后，再点击确认。"; form.append(note);
    }
    form.append(status, actions); card.append(form);
    const submit = action => {
      try {
        if (action === "accept" && !form.reportValidity()) return;
        const message = { type: "interactionResponse", key: approval.key, requestId: "interaction-" + crypto.randomUUID() };
        if (approval.kind === "question") message.answers = Object.fromEntries(readers.map(read => read()));
        else { message.action = action; if (action === "accept" && approval.kind === "form") message.content = form.dataset.json === "true" ? readers[0]() : Object.fromEntries(readers.map(read => read()).filter(Boolean)); }
        const timer = setTimeout(() => this.error({ requestId: message.requestId, message: "未收到提交确认，请重新连接或重试" }), 20000);
        this.pending.set(message.requestId, { key: approval.key, form, status, timer });
        if (!send(message)) { this.error({ requestId: message.requestId, message: "连接已断开，请重新连接后提交" }); return; }
        status.textContent = "正在提交…"; form.querySelectorAll("button").forEach(button => { button.disabled = true; });
      } catch (error) { status.textContent = error.message; }
    };
    const button = (label, action, primary = false) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + (primary ? "primary" : "secondary"); b.textContent = label; b.onclick = () => submit(action); actions.append(b); };
    button(approval.kind === "question" ? "提交回答" : approval.kind === "form" ? "提交表单" : "已完成授权", "accept", true);
    if (approval.kind !== "question") { button("拒绝", "decline"); button("取消", "cancel"); }
    form.onsubmit = event => { event.preventDefault(); submit("accept"); };
  }
};
