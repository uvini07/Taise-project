/* =========================================================
   BACKEND (Google Apps Script) — Taise Foto | Agendamentos de Natal
   -----------------------------------------------------------------
   Como usar:
   1. Crie uma planilha nova no Google Sheets.
   2. Renomeie a primeira aba para exatamente: appointments
   3. Na primeira linha dessa aba, cole estes cabeçalhos (uma coluna cada):
      id | name | phone | email | package | lot | lotPrice | addons | addonsValor |
      total | pagamento | date | time | status | notes | createdAt | updatedAt
      (as colunas que faltarem sao criadas sozinhas no primeiro agendamento)
   4. No menu da planilha: Extensões > Apps Script.
   5. Apague o conteúdo padrão do editor e cole todo este arquivo.
   6. Clique em Implantar > Nova implantação > tipo "App da Web".
      - Executar como: Eu (sua conta)
      - Quem pode acessar: Qualquer pessoa
   7. Copie a URL gerada (termina em /exec) e cole em CONFIG.sheetsApiUrl
      no arquivo do site (taisefotonatal2.html).
   8. Sempre que editar este script, é preciso implantar de novo
      (Implantar > Gerenciar implantações > editar o ícone de lápis >
      Versão: Nova versão > Implantar). Só editar o código no editor NÃO
      atualiza a URL /exec sozinho.

   ATUALIZAÇÃO: corrige o bug em que o Google Sheets convertia sozinho
   as colunas "date" e "time" (ex.: "2026-11-05" e "14:00") em datas/horas
   de verdade, fazendo aparecer "Invalid Date" ou "1899-12-30T..." no site.
   Agora a coluna é forçada como texto simples ao gravar, e qualquer
   célula antiga que já tenha virado data é normalizada de volta na leitura.

   ATUALIZAÇÃO 2 (lista VIP): cria automaticamente (não precisa criar manual)
   duas abas novas na primeira vez que forem usadas: "settings" (liga/desliga
   o card VIP e guarda o horário de lançamento) e "vip" (cadastros de e-mail,
   limite de 20). Não precisa mexer na planilha — as abas aparecem sozinhas.

   ATUALIZAÇÃO 5 (meia hora do Pacote Família): a partir de 01/12, cada
   Pacote Família marcado numa hora cheia (ex.: 09:00) abre uma vaga na meia
   hora seguinte (09:30). Essa vaga só aparece — e só pode ser ocupada — por
   quem também escolher o Pacote Família. Os demais pacotes continuam vendo
   apenas as horas cheias. Ajuste em MEIA_HORA_INICIO / MEIA_HORA_PACOTE.

   ATUALIZAÇÃO 4 (vagas VIP para compra): a aba "settings" ganha a chave
   "vip-vagas-compra" — quantos ensaios a Lista VIP pode fechar. Não tem
   relação com quantas pessoas se cadastraram: levam as vagas os primeiros
   que comprarem. Dá para editar a célula direto na planilha ou usar o campo
   "Vagas para compra" no painel administrativo.

   ATUALIZAÇÃO 3: na aba "settings", a célula "VIP-status" (coluna B, ao
   lado da chave "VIP-status" na coluna A) é o controle direto do card VIP —
   "on" = card aparece no site, "off" = card some. Pode editar essa célula
   direto na planilha OU usar o botão de liga/desliga no painel
   administrativo — os dois fazem exatamente a mesma coisa, sempre lendo o
   valor mais recente da planilha (nunca fica em cache).
========================================================= */

const SHEET_NAME = "appointments";
const SETTINGS_SHEET_NAME = "settings";
const VIP_SHEET_NAME = "vip";
// Meia hora extra do Pacote Familia: a partir de MEIA_HORA_INICIO, cada
// Familia marcado numa hora cheia abre a meia hora seguinte, e so outro
// Familia pode ocupa-la. O nome precisa ser igual ao gravado na coluna
// "package" da planilha (o mesmo CONFIG.packages[].name do site).
const MEIA_HORA_INICIO = "2026-12-01";
const MEIA_HORA_PACOTE = "Pacote Família";

const VIP_MAX_SIGNUPS = 20;      // limite de CADASTROS na lista VIP
const VIP_VAGAS_COMPRA_PADRAO = 20; // limite de COMPRAS pela lista VIP (padrao)
const TZ = Session.getScriptTimeZone();

/* ---------------- SEGURANÇA ----------------
   Três regras que valem para tudo abaixo:
   1. doGet é PÚBLICO — qualquer pessoa na internet consegue abrir a URL /exec.
      Por isso ele NUNCA devolve nome, telefone, e-mail, observação, nem a
      lista VIP. Devolve só o que o site precisa para montar o calendário:
      quais data/hora já estão ocupadas e quantas vagas de cada lote foram
      usadas. Sem isso, os dados de todos os clientes ficavam abertos.
   2. Ler os dados completos e mexer em qualquer coisa (confirmar, cancelar,
      ligar VIP, lançar VIP) exige um token de admin, emitido só depois de
      login com usuário e senha conferidos AQUI no servidor.
   3. A senha não fica no site nem na planilha: fica no Script Properties,
      guardada como hash SHA-256 com sal. Para trocar, rode changeAdminPassword.
------------------------------------------------ */

function readAllAppointments() {
  const sheet = getSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows.shift();
  return rows
    .filter(r => r.some(cell => cell !== ""))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = normalizeCell(h, r[i]); });
      return obj;
    });
}

// Versão pública: só o que o calendário precisa saber. Nada identificável.
function publicAvailability(list) {
  return list.map(function (a) {
    return {
      date: a.date || "",
      time: a.time || "",
      package: a.package || "",
      lot: a.lot || "",
      status: a.status || ""
    };
  });
}

function doGet(e) {
  const settings = readSettings();
  const vipRows = readVipSignups();
  return jsonOut({
    ok: true,
    appointments: publicAvailability(readAllAppointments()),
    settings: { vipEnabled: settings.vipEnabled, vipLaunchAt: settings.vipLaunchAt },
    vipCount: vipRows.length,
    vipMax: VIP_MAX_SIGNUPS
  });
}

/* ---------------- autenticação do admin ---------------- */

function sha256Hex(str) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  return raw.map(function (b) {
    const v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

// Sal/segredo do projeto — criado sozinho na primeira vez e nunca sai daqui.
function adminSecret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty("ADMIN_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("ADMIN_SECRET", s);
  }
  return s;
}

// Rode esta função UMA VEZ no editor do Apps Script para trocar a senha.
// Selecione changeAdminPassword no seletor de função e clique em Executar
// depois de editar os dois valores abaixo.
function changeAdminPassword() {
  const NOVO_USUARIO = "Taisefoto";
  const NOVA_SENHA   = "troque-esta-senha";
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_USER: NOVO_USUARIO,
    ADMIN_PASS_HASH: sha256Hex(NOVA_SENHA + "|" + adminSecret())
  });
  return "Senha do admin atualizada.";
}

function adminCredentials() {
  const props = PropertiesService.getScriptProperties();
  const user = props.getProperty("ADMIN_USER");
  const hash = props.getProperty("ADMIN_PASS_HASH");
  if (user && hash) return { user: user, hash: hash };
  // Primeiro acesso: usa as credenciais iniciais e já as guarda como hash,
  // para que a senha deixe de existir em texto puro a partir daí.
  const bootUser = "Taisefoto";
  const bootPass = "110307";
  const bootHash = sha256Hex(bootPass + "|" + adminSecret());
  props.setProperties({ ADMIN_USER: bootUser, ADMIN_PASS_HASH: bootHash });
  return { user: bootUser, hash: bootHash };
}

const ADMIN_TOKEN_HOURS = 8;

function makeAdminToken() {
  const exp = Date.now() + ADMIN_TOKEN_HOURS * 60 * 60 * 1000;
  return exp + "." + sha256Hex(exp + "|" + adminSecret());
}

function isAdminToken(token) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!exp || Date.now() > exp) return false;
  return parts[1] === sha256Hex(exp + "|" + adminSecret());
}

function adminLogin(user, pass) {
  const cred = adminCredentials();
  const okUser = String(user || "").trim() === cred.user;
  const okPass = sha256Hex(String(pass || "") + "|" + adminSecret()) === cred.hash;
  // resposta igual para usuário errado e senha errada — não entrega qual falhou
  if (!okUser || !okPass) return { ok: false, reason: "invalid_credentials" };
  return { ok: true, token: makeAdminToken(), expiresInHours: ADMIN_TOKEN_HOURS };
}

// Dados completos (com dados pessoais) — só com token válido.
function adminData() {
  return { ok: true, appointments: readAllAppointments(), vip: readVipSignups(), settings: readSettings() };
}

/* ---------------- validação VIP sem expor a lista ---------------- */
// O site manda o e-mail/telefone digitado e recebe só "é VIP ou não".
// A lista de clientes nunca desce para o navegador.
function vipCheck(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, member: false };
  const isEmail = raw.indexOf("@") !== -1;
  const email = raw.toLowerCase();
  const phone = vipPhoneDigits(raw);
  if (!isEmail && phone.length < 8) return { ok: true, member: false };

  const rows = readVipSignups();
  for (var i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (var k in row) {
      const val = row[k];
      if (val === undefined || val === null) continue;
      const s = String(val).trim();
      if (!s) continue;
      if (isEmail) {
        if (s.toLowerCase() === email) return { ok: true, member: true, name: row.name || row.nome || "" };
      } else {
        const d = vipPhoneDigits(s);
        if (d.length >= 8 && d === phone) return { ok: true, member: true, name: row.name || row.nome || "" };
      }
    }
  }
  return { ok: true, member: false };
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // Se não conseguir o lock em 20s, devolve "busy" em vez de estourar erro —
    // assim o site pode avisar "tente de novo" em vez de mostrar falha técnica.
    lock.waitLock(20000);
  } catch (lockErr) {
    return jsonOut({ ok: false, reason: "busy" });
  }
  try {
    const body = JSON.parse(e.postData.contents);
    const sheet = getSheet();

    // --- ações públicas ---
    if (body.action === "create") {
      return jsonOut(createAppointment(sheet, body.appointment));
    }
    if (body.action === "vipSignup") {
      return jsonOut(vipSignup(body.name, body.email, body.phone));
    }
    if (body.action === "vipStatus") {
      return jsonOut(vipStatus());
    }
    if (body.action === "vipCheck") {
      return jsonOut(vipCheck(body.value));
    }
    if (body.action === "adminLogin") {
      return jsonOut(adminLogin(body.user, body.pass));
    }

    // --- daqui pra baixo, só com token de admin válido ---
    const adminActions = ["adminData", "updateStatus", "vipToggle", "vipLaunch", "vipSignupToggle", "vipVagas"];
    if (adminActions.indexOf(body.action) !== -1) {
      if (!isAdminToken(body.token)) {
        return jsonOut({ ok: false, reason: "unauthorized" });
      }
      if (body.action === "adminData") return jsonOut(adminData());
      if (body.action === "updateStatus") return jsonOut(updateStatus(sheet, body.id, body.status));
      if (body.action === "vipToggle") return jsonOut(vipToggle(body.enabled));
      if (body.action === "vipLaunch") return jsonOut(vipLaunch());
      if (body.action === "vipSignupToggle") return jsonOut(vipSignupToggle(body.open));
      if (body.action === "vipVagas") return jsonOut(vipSetVagas(body.vagas));
    }

    return jsonOut({ ok: false, reason: "unknown_action" });
  } catch (err) {
    return jsonOut({ ok: false, reason: "server_error", message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- VIP / settings ---------------- */

function getSettingsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    sheet.getRange(1, 1, 2, 2).setNumberFormat("@");
    // Já cria a linha "VIP-status" = "off" por padrão — é essa célula que
    // liga/desliga o card VIP. Pode editar direto na planilha (on/off) ou
    // pelo botão no painel administrativo, dá no mesmo.
    sheet.getRange(1, 1, 2, 2).setValues([["key", "value"], ["VIP-status", "off"]]);
  }
  return sheet;
}

function getVipSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(VIP_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(VIP_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([["id", "name", "email", "createdAt"]]);
  }
  return sheet;
}

// Lê a aba "settings" toda vez (nunca fica em cache) — assim, se alguém
// mudar a célula "VIP-status" direto na planilha para "on"/"off", o site
// reflete isso na próxima vez que carregar, sem precisar mexer no admin.
// Compara chaves ignorando espaços em volta, maiúsculas e a diferença entre
// hífen, espaço e underscore — assim "VIP-status", "vip status" e " VIP_Status"
// são a mesma configuração, e o admin não cria uma linha duplicada ao gravar.
function normalizeSettingKey(key) {
  return String(key === undefined || key === null ? "" : key)
    .trim().toLowerCase().replace(/[\s_]+/g, "-");
}

// A célula pode ter sido preenchida à mão de várias formas, ou ser uma caixa
// de seleção do Sheets (que chega como booleano).
function settingIsOn(value) {
  if (value === true) return true;
  const v = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  return v === "on" || v === "true" || v === "sim" || v === "1" || v === "ligado" || v === "ativo";
}

function readSettings() {
  const sheet = getSettingsSheet();
  const rows = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const key = normalizeSettingKey(rows[i][0]);
    if (key) map[key] = rows[i][1];
  }
  // Aceita tanto a chave nova "VIP-status" (on/off, editável direto na
  // planilha) quanto a antiga "vipEnabled" (true/false), para não perder
  // configuração de quem já tinha usado a versão anterior.
  const rawStatus = map["vip-status"] !== undefined ? map["vip-status"] : map["vipenabled"];
  // "signup-status" controla só o formulário da página de inscrição, separado
  // do lançamento dos benefícios. Enquanto a chave não existir na planilha vale
  // a regra antiga: o cadastro fecha sozinho quando o acesso VIP é lançado.
  const rawSignup = map["signup-status"];
  const temSignup = rawSignup !== undefined && String(rawSignup).trim() !== "";
  // "vip-vagas-compra" e quantas pessoas da lista podem efetivamente FECHAR
  // um ensaio. Nada a ver com quantas se cadastraram: levam os primeiros que
  // comprarem. Enquanto a chave nao existir na planilha, vale o padrao.
  const rawVagas = map["vip-vagas-compra"];
  const vagas = parseInt(String(rawVagas === undefined ? "" : rawVagas).trim(), 10);
  return {
    vipEnabled: settingIsOn(rawStatus),
    vipLaunchAt: map["viplaunchat"] ? String(map["viplaunchat"]) : null,
    signupOpen: temSignup ? settingIsOn(rawSignup) : !map["viplaunchat"],
    vipVagasCompra: (!isNaN(vagas) && vagas >= 0) ? vagas : VIP_VAGAS_COMPRA_PADRAO
  };
}

function writeSetting(key, value) {
  const sheet = getSettingsSheet();
  const rows = sheet.getDataRange().getValues();
  const alvo = normalizeSettingKey(key);
  for (let i = 1; i < rows.length; i++) {
    if (normalizeSettingKey(rows[i][0]) === alvo) {
      const cell = sheet.getRange(i + 1, 2);
      cell.setNumberFormat("@");
      cell.setValue(String(value));
      return;
    }
  }
  const nextRow = sheet.getLastRow() + 1;
  const range = sheet.getRange(nextRow, 1, 1, 2);
  range.setNumberFormat("@");
  range.setValues([[key, String(value)]]);
}

function vipToggle(enabled) {
  writeSetting("VIP-status", enabled ? "on" : "off");
  return { ok: true, settings: readSettings() };
}

function vipLaunch() {
  writeSetting("vipLaunchAt", new Date().toISOString());
  writeSetting("VIP-status", "on");
  return { ok: true, settings: readSettings() };
}

// Define quantas compras a lista VIP aceita. Pode tambem ser editado direto
// na aba "settings", na celula ao lado da chave "vip-vagas-compra".
function vipSetVagas(vagas) {
  const n = Math.max(0, parseInt(vagas, 10) || 0);
  writeSetting("vip-vagas-compra", n);
  return { ok: true, settings: readSettings() };
}

// Abre ou fecha só o formulário da página de inscrição, sem mexer no
// lançamento dos benefícios nem no card do site.
function vipSignupToggle(open) {
  writeSetting("signup-status", open ? "on" : "off");
  return { ok: true, settings: readSettings() };
}

function readVipSignups() {
  const sheet = getVipSheet();
  const rows = sheet.getDataRange().getValues();
  const headers = rows.shift();
  return rows
    .filter(r => r.some(cell => cell !== ""))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = normalizeCell(h, r[i]); });
      return obj;
    });
}

// Descobre a coluna certa pelo nome do cabeçalho, aceitando as variações que
// a planilha pode ter (email/e-mail, phone/telefone/celular/whatsapp...).
function vipFindCol(headers, re) {
  for (var i = 0; i < headers.length; i++) {
    if (re.test(String(headers[i]).trim())) return i;
  }
  return -1;
}

function vipPhoneDigits(s) {
  var d = String(s || "").replace(/\D/g, "");
  if (d.length > 11 && d.indexOf("55") === 0) d = d.slice(2);
  return d;
}

function vipReadHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    sheet.getRange(1, 1, 1, 5).setValues([["id", "name", "email", "phone", "createdAt"]]);
    return ["id", "name", "email", "phone", "createdAt"];
  }
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

// Só conta e devolve as vagas — nunca devolve e-mail ou telefone de ninguém,
// porque essa é a chamada que a página pública de inscrição usa.
function vipStatus() {
  var sheet = getVipSheet();
  var rows = sheet.getDataRange().getValues();
  var body = rows.slice(1).filter(function (r) { return r.some(function (c) { return c !== ""; }); });
  var settings = readSettings();
  return {
    ok: true,
    count: body.length,
    max: VIP_MAX_SIGNUPS,
    remaining: Math.max(0, VIP_MAX_SIGNUPS - body.length),
    signupOpen: settings.signupOpen,
    launched: !!settings.vipLaunchAt
  };
}

// IMPORTANTE (corrida de vagas): esta função roda sempre dentro do lock do
// doPost, e a contagem é lida da planilha AQUI DENTRO, no momento da gravação.
// Então, se duas pessoas enviarem ao mesmo tempo com 19 preenchidas, a segunda
// só é processada depois que a primeira já gravou a linha 20 — e recebe "full".
// Nunca dá pra passar de VIP_MAX_SIGNUPS.
function vipSignup(name, email, phone) {
  var settings = readSettings();
  if (!settings.signupOpen) {
    return { ok: false, reason: "launched" };
  }

  var cleanName = String(name || "").trim();
  var cleanEmail = String(email || "").trim().toLowerCase();
  var phoneDigits = vipPhoneDigits(phone);
  if (!cleanName) return { ok: false, reason: "invalid_name" };
  if (!cleanEmail || cleanEmail.indexOf("@") === -1) return { ok: false, reason: "invalid_email" };
  if (phoneDigits.length < 10) return { ok: false, reason: "invalid_phone" };

  var sheet = getVipSheet();
  var headers = vipReadHeaders(sheet);

  // garante uma coluna de telefone sem duplicar a que já existir
  var phoneCol = vipFindCol(headers, /^(phone|telefone|celular|whatsapp|fone|contato)$/i);
  if (phoneCol === -1) {
    sheet.getRange(1, headers.length + 1).setValue("phone");
    headers = headers.concat(["phone"]);
    phoneCol = headers.length - 1;
  }
  var emailCol = vipFindCol(headers, /mail/i);
  var rows = sheet.getDataRange().getValues();
  var body = rows.slice(1).filter(function (r) { return r.some(function (c) { return c !== ""; }); });

  var dupEmail = emailCol !== -1 && body.some(function (r) {
    return String(r[emailCol] || "").trim().toLowerCase() === cleanEmail;
  });
  var dupPhone = body.some(function (r) {
    var d = vipPhoneDigits(r[phoneCol]);
    return d && d === phoneDigits;
  });
  if (dupEmail || dupPhone) {
    return { ok: false, reason: "duplicate", count: body.length, max: VIP_MAX_SIGNUPS, remaining: Math.max(0, VIP_MAX_SIGNUPS - body.length) };
  }

  // ---- a checagem que impede a 21ª inscrição ----
  if (body.length >= VIP_MAX_SIGNUPS) {
    return { ok: false, reason: "full", count: body.length, max: VIP_MAX_SIGNUPS, remaining: 0 };
  }

  var values = {
    id: Utilities.getUuid(),
    name: cleanName,
    email: cleanEmail,
    phone: forceText(String(phone || "").trim()),
    createdat: new Date().toISOString(),
    updatedat: new Date().toISOString()
  };
  var row = headers.map(function (h) {
    var key = String(h).trim().toLowerCase();
    if (key === "telefone" || key === "celular" || key === "whatsapp" || key === "fone" || key === "contato") key = "phone";
    if (key === "nome") key = "name";
    if (key === "e-mail") key = "email";
    return values[key] !== undefined ? values[key] : "";
  });

  var nextRow = sheet.getLastRow() + 1;
  var range = sheet.getRange(nextRow, 1, 1, row.length);
  range.setNumberFormat("@");
  range.setValues([row]);

  var novoTotal = body.length + 1;
  return { ok: true, count: novoTotal, max: VIP_MAX_SIGNUPS, remaining: Math.max(0, VIP_MAX_SIGNUPS - novoTotal) };
}

// Limpa e limita tudo que veio do navegador antes de encostar na planilha.
// Sem isso, dá pra mandar um texto gigante, uma fórmula, ou forjar o status
// "confirmado" direto pela API, pulando a aprovação do painel.
function sanitizeAppointment(appt) {
  function txt(v, max) {
    return String(v === undefined || v === null ? "" : v).trim().slice(0, max);
  }
  const clean = {
    id: txt(appt && appt.id, 60),
    name: txt(appt && appt.name, 90),
    phone: txt(appt && appt.phone, 30),
    email: txt(appt && appt.email, 120),
    package: txt(appt && appt.package, 60),
    lot: txt(appt && appt.lot, 40),
    lotPrice: txt(appt && appt.lotPrice, 30),
    // Itens adicionais e valores fechados: sem estes campos o painel mostrava
    // o pedido sem os adicionais e sem o total.
    addons: txt(appt && appt.addons, 300),
    addonsValor: txt(appt && appt.addonsValor, 30),
    total: txt(appt && appt.total, 30),
    pagamento: txt(appt && appt.pagamento, 200),
    date: txt(appt && appt.date, 10),
    time: txt(appt && appt.time, 5),
    notes: txt(appt && appt.notes, 500),
    lotVagas: appt ? appt.lotVagas : null,
    // O status NUNCA vem do navegador: todo pedido nasce pendente e só o
    // painel autenticado pode mudar depois.
    status: "pendente",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!clean.id) clean.id = Utilities.getUuid();
  if (!clean.name || !clean.phone) return { erro: "invalid_data" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean.date)) return { erro: "invalid_date" };
  if (!/^\d{2}:\d{2}$/.test(clean.time)) return { erro: "invalid_time" };
  if (clean.email && clean.email.indexOf("@") === -1) return { erro: "invalid_email" };
  return clean;
}

const REQUIRED_COLS = ["id","name","phone","email","package","lot","lotPrice",
  "addons","addonsValor","total","pagamento","date","time","status","notes",
  "createdAt","updatedAt"];

// Planilhas criadas antes desta versao nao tem as colunas de adicionais/total.
// Em vez de pedir pra editar o cabecalho na mao, acrescenta o que falta no fim.
function ensureColumns(sheet) {
  const last = sheet.getLastColumn();
  const headers = last ? sheet.getRange(1, 1, 1, last).getValues()[0].map(String) : [];
  const faltando = REQUIRED_COLS.filter(function (c) { return headers.indexOf(c) === -1; });
  if (!faltando.length) return;
  sheet.getRange(1, last + 1, 1, faltando.length).setValues([faltando]);
}

function createAppointment(sheet, rawAppt) {
  const appt = sanitizeAppointment(rawAppt);
  if (appt.erro) return { ok: false, reason: appt.erro };
  ensureColumns(sheet);
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const dateCol = headers.indexOf("date");
  const timeCol = headers.indexOf("time");
  const statusCol = headers.indexOf("status");
  const packageCol = headers.indexOf("package");
  const lotCol = headers.indexOf("lot");

  // Revalida o conflito de horário aqui dentro, protegido pelo lock acima —
  // é isso que garante que duas pessoas não consigam reservar o mesmo horário.
  // Usa normalizeCell pra comparar corretamente mesmo com linhas antigas
  // que o Sheets tenha convertido em data/hora.
  const clash = rows.slice(1).some(r =>
    normalizeCell("date", r[dateCol]) === appt.date &&
    normalizeCell("time", r[timeCol]) === appt.time &&
    r[statusCol] !== "cancelado"
  );
  if (clash) return { ok: false, reason: "conflict" };

  // Meia hora extra (ex.: 09:30): so vale para o Pacote Familia, so a partir
  // de MEIA_HORA_INICIO e so se houver um Familia nao cancelado na hora cheia
  // correspondente. Roda dentro do mesmo lock, entao ninguem consegue ocupar
  // a meia hora de um ensaio que acabou de ser cancelado.
  if (/^\d{2}:30$/.test(appt.time)) {
    if (appt.package !== MEIA_HORA_PACOTE) return { ok: false, reason: "invalid_slot" };
    if (appt.date < MEIA_HORA_INICIO) return { ok: false, reason: "invalid_slot" };
    const horaCheia = appt.time.slice(0, 2) + ":00";
    const abriu = rows.slice(1).some(r =>
      normalizeCell("date", r[dateCol]) === appt.date &&
      normalizeCell("time", r[timeCol]) === horaCheia &&
      r[packageCol] === MEIA_HORA_PACOTE &&
      r[statusCol] !== "cancelado"
    );
    if (!abriu) return { ok: false, reason: "invalid_slot" };
  }

  // Vagas de COMPRA da lista VIP. Roda dentro do mesmo lock da criacao, entao
  // duas pessoas da lista nunca levam a mesma ultima vaga. Quem fecha primeiro
  // leva, independente da posicao em que entrou na lista.
  if (String(appt.lot || "").trim().toUpperCase() === "VIP") {
    const limite = readSettings().vipVagasCompra;
    const usadas = rows.slice(1).filter(r =>
      String(r[lotCol] || "").trim().toUpperCase() === "VIP" && r[statusCol] !== "cancelado"
    ).length;
    if (usadas >= limite) return { ok: false, reason: "vip_sold_out" };
  }

  // Revalida as vagas do lote aqui dentro também (mesmo lock), evitando que
  // duas pessoas peguem a última vaga do mesmo lote ao mesmo tempo.
  // appt.lotVagas vem do site (limite configurado para aquele lote); null/vazio
  // significa lote sem limite fixo (não conta).
  if (appt.lotVagas !== null && appt.lotVagas !== undefined && appt.lotVagas !== "") {
    const used = rows.slice(1).filter(r =>
      r[packageCol] === appt.package && r[lotCol] === appt.lot && r[statusCol] !== "cancelado"
    ).length;
    if (used >= Number(appt.lotVagas)) return { ok: false, reason: "sold_out" };
  }

  const row = headers.map(h => (appt[h] !== undefined && appt[h] !== null) ? forceText(String(appt[h])) : "");
  const nextRow = sheet.getLastRow() + 1;
  const range = sheet.getRange(nextRow, 1, 1, row.length);
  range.setNumberFormat("@"); // força texto simples — impede o Sheets de converter data/hora sozinho
  range.setValues([row]);
  return { ok: true };
}

// O Sheets interpreta valores que começam com "+", "-", "=" ou "@" como início
// de fórmula (ex.: telefone "+55 11 91234-5678" virava #ERROR!), mesmo com a
// coluna formatada como texto. Um apóstrofo no início força texto literal —
// o próprio Sheets remove esse apóstrofo da exibição, mas guarda o resto como
// texto puro (é o mesmo truque de digitar '+55... manualmente na planilha).
function forceText(value) {
  if (/^[+\-=@]/.test(value)) return "'" + value;
  return value;
}

function updateStatus(sheet, id, status) {
  if (["pendente", "confirmado", "cancelado"].indexOf(String(status)) === -1) {
    return { ok: false, reason: "invalid_status" };
  }
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const idCol = headers.indexOf("id");
  const statusCol = headers.indexOf("status");
  const updatedAtCol = headers.indexOf("updatedAt");

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idCol]) === String(id)) {
      sheet.getRange(i + 1, statusCol + 1).setValue(status);
      if (updatedAtCol > -1) {
        const cell = sheet.getRange(i + 1, updatedAtCol + 1);
        cell.setNumberFormat("@");
        cell.setValue(new Date().toISOString());
      }
      return { ok: true };
    }
  }
  return { ok: false, reason: "not_found" };
}

// Se o Sheets converteu "date"/"time"/"createdAt"/"updatedAt" para um valor de
// data de verdade (objeto Date), devolve como texto no formato esperado pelo
// site. Se já for texto normal, devolve como está.
function normalizeCell(header, value) {
  if (!(value instanceof Date)) return value;
  if (header === "date") return Utilities.formatDate(value, TZ, "yyyy-MM-dd");
  if (header === "time") return Utilities.formatDate(value, TZ, "HH:mm");
  if (header === "createdAt" || header === "updatedAt") return value.toISOString();
  return value.toISOString();
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Aba "' + SHEET_NAME + '" não encontrada. Renomeie a primeira aba da planilha.');
  return sheet;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
