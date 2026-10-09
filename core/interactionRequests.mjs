const record = value => value && typeof value === "object" && !Array.isArray(value);
export const isInteraction = a => ["question", "form", "url"].includes(a?.kind);

export function buildInteraction(method, params) {
  if (method === "item/tool/requestUserInput") {
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 16) throw new Error("提问数量无效");
    const questions = params.questions.map(q => {
      if (!q.id || typeof q.question !== "string" || q.question.length > 8192 || (q.options?.length || 0) > 32) throw new Error("提问内容无效");
      return { id: q.id, header: String(q.header || "").slice(0, 256), question: q.question, isOther: !!q.isOther, isSecret: !!q.isSecret, options: q.options?.map(o => ({ label: String(o.label).slice(0, 1024), description: String(o.description || "").slice(0, 2048) })) || [] };
    });
    if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error("问题编号重复");
    return { kind: "question", title: "需要你回答", command: "请回答以下问题", questions };
  }
  if (method !== "mcpServer/elicitation/request") return null;
  const common = { title: "工具需要补充信息", command: String(params.message || "").slice(0, 8192), serverName: String(params.serverName || "").slice(0, 256) };
  if (params.mode === "url") {
    let url;
    try { url = new URL(params.url); } catch { throw new Error("授权链接无效"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("授权链接无效");
    return { ...common, kind: "url", url: url.href };
  }
  if (!["form", "openai/form"].includes(params.mode)) throw new Error("暂不支持该提问模式");
  if (!record(params.requestedSchema) || JSON.stringify(params.requestedSchema).length > 65536) throw new Error("表单定义无效或过大");
  return { ...common, kind: "form", schema: params.requestedSchema };
}

function validate(value, schema, name = "表单", depth = 0) {
  if (!record(schema) || depth > 8 || schema.$ref) throw new Error(name + "：暂不支持该字段定义");
  const supported = new Set(["$schema", "$id", "type", "title", "description", "default", "examples", "properties", "required", "additionalProperties", "enum", "enumNames", "const", "anyOf", "oneOf", "minLength", "maxLength", "format", "minimum", "maximum", "items", "minItems", "maxItems", "uniqueItems"]);
  for (const [key, constraint] of Object.entries(schema)) if (constraint !== undefined && !supported.has(key)) throw new Error(name + "：暂不支持约束 " + key);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") throw new Error(name + "：暂不支持额外字段约束");
  if (schema.format && !["email", "uri", "date", "date-time", "password"].includes(schema.format)) throw new Error(name + "：暂不支持该字段格式");
  if (schema.anyOf || schema.oneOf) {
    const variants = schema.anyOf || schema.oneOf;
    // 官方枚举以 const/title 描述选项；其他组合约束明确拒绝，避免覆盖父字段限制。
    if (schema.anyOf && schema.oneOf || !Array.isArray(variants) || !variants.length || !variants.every(v => record(v) && typeof v.const === "string" && Object.keys(v).every(key => ["const", "title", "description"].includes(key)))) throw new Error(name + "：暂不支持该组合约束");
    const base = { ...schema, anyOf: undefined, oneOf: undefined };
    if (base.type || base.enum || base.const !== undefined) validate(value, base, name, depth + 1);
    else if (Object.keys(base).some(key => base[key] !== undefined && !["title", "description", "$schema", "$id", "default", "examples"].includes(key))) throw new Error(name + "：暂不支持未声明类型的约束");
    const matches = variants.filter(variant => variant.const === value).length;
    if (matches < 1 || (schema.oneOf && matches !== 1)) throw new Error(name + "：值不符合选项");
    return;
  }
  if (schema.const !== undefined && value !== schema.const) throw new Error(name + "：值不符合选项");
  if (schema.enum && !schema.enum.includes(value)) throw new Error(name + "：请选择有效选项");
  switch (schema.type) {
    case "object": {
      if (!record(value)) throw new Error(name + "：请输入对象");
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(key + "：请填写必填字段");
      for (const [key, content] of Object.entries(value)) {
        const field = schema.properties?.[key];
        if (!field) throw new Error(key + "：未知字段");
        validate(content, field, key, depth + 1);
      }
      break;
    }
    case "string":
      if (typeof value !== "string") throw new Error(name + "：请输入文字");
      if (value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 8192)) throw new Error(name + "：文字长度不符合要求");
      if (schema.pattern) throw new Error(name + "：暂不支持正则约束");
      if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(name + "：邮箱格式无效");
      if (schema.format === "uri") { try { new URL(value); } catch { throw new Error(name + "：链接格式无效"); } }
      if (schema.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(name + "：日期格式无效");
      if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) throw new Error(name + "：日期时间格式无效");
      break;
    case "number": case "integer":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(name + "：数值不符合要求");
      break;
    case "boolean": if (typeof value !== "boolean") throw new Error(name + "：请选择是或否"); break;
    case "array":
      if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 64) || (schema.uniqueItems && new Set(value).size !== value.length)) throw new Error(name + "：选项数量不符合要求");
      value.forEach(v => validate(v, schema.items, name, depth + 1)); break;
    default: if (schema.const === undefined && !schema.enum) throw new Error(name + "：暂不支持该字段类型");
  }
}

export function interactionResult(approval, message) {
  if (approval.kind === "question") {
    if (!record(message.answers) || JSON.stringify(message.answers).length > 65536) throw new Error("请填写回答");
    const answers = Object.create(null);
    for (const q of approval.questions) {
      const values = message.answers[q.id]?.answers;
      if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string" || !values[0].trim() || values[0].length > 8192) throw new Error(q.header + "：请填写回答");
      if (q.options.length && !q.isOther && !q.options.some(o => o.label === values[0])) throw new Error(q.header + "：请选择有效回答");
      answers[q.id] = { answers: values };
    }
    return { answers };
  }
  const action = message.action;
  if (!["accept", "decline", "cancel"].includes(action)) throw new Error("请选择有效操作");
  const content = action === "accept" && approval.kind === "form" ? message.content : null;
  if (action === "accept" && approval.kind === "form") {
    if (JSON.stringify(content)?.length > 65536) throw new Error("表单内容过大");
    validate(content, approval.schema);
  }
  return { action, content, _meta: null };
}
