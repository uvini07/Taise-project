/* =========================================================
   POLAROIDY — assistente com IA no painel administrativo
   ---------------------------------------------------------
   A Taíse usa este site temporariamente, até migrar para a Revela. Enquanto
   isso, a mesma Polaroidy da Revela também vive aqui.

   Como funciona:
   - O botão só aparece dentro do painel (#admin-view), com a Taíse logada.
   - As perguntas vão para a função da Vercel deste projeto
     (CONFIG.polaroidyApi → api/polaroid-natal.js, neste projeto), que só conversa com a IA.
   - Os dados (agendamentos, pagamentos, VIP) NÃO saem do painel por conta
     própria: a IA pede uma "ferramenta", este arquivo responde lendo o
     appointmentsCache já carregado com o login da Taíse.
   - A IA nunca confirma, cobra ou registra nada sozinha: ela mostra botões,
     e a ação só acontece quando a Taíse toca.

   Depende de funções do index.html (appointmentsCache, pgTotalDe,
   pgRecebido, pgSituacaoDe, timesForDate, updateAppointmentStatus, apiPost,
   refreshAdminData, showToast). Carregar DEPOIS do script principal.
========================================================= */
(function(){
  "use strict";
  const API = (window.CONFIG_POLAROIDY_API) || (typeof CONFIG !== "undefined" && CONFIG.polaroidyApi) || "";

  /* ---------- utilidades ---------- */
  const hojeISO = () => toISODate(new Date());
  const maisDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return toISODate(d); };
  const okDia = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const diaBR = (iso) => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "";
  const semana = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("pt-BR", { weekday: "long" });
  const brl = (n) => "R$ " + (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const mesmoNome = (cheio, q) => { const a = norm(cheio), b = norm(q); return !!b && (a === b || a.includes(b) || b.split(/\s+/).every(w => a.includes(w))); };
  const primeiro = (n) => String(n || "").split(" ")[0];
  const zap = (tel, txt) => { let d = String(tel || "").replace(/\D/g, ""); if (d && d.length <= 11) d = "55" + d; return "https://wa.me/" + d + "?text=" + encodeURIComponent(txt); };
  const ativos = () => (appointmentsCache || []).filter(a => a.status !== "cancelado");
  const ordem = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);
  const SITUACAO = { pendente: "Aguardando confirmação", confirmado: "Confirmado", cancelado: "Cancelado" };
  const PAG = { aberto: "Sem pagamento", sinal: "Sinal pago", quitado: "Quitado" };
  const resumo = (a) => ({
    data: a.date, hora: a.time, cliente: a.name || "", pacote: a.package || "", lote: a.lot || "",
    situacao: SITUACAO[a.status] || a.status, pagamento: PAG[pgSituacaoDe(a)],
    total: brl(pgTotalDe(a)), recebido: brl(pgRecebido(a)), whatsapp: a.phone || "",
  });

  const MENSAGENS = {
    confirmacao: (n, a) => `Oi, ${n}! Aqui é a Taise 💌 Seu ensaio de Natal (${a.package || "ensaio"}) está confirmado para ${semana(a.date)}, ${diaBR(a.date)}, às ${a.time}. Qualquer dúvida, é só me chamar!`,
    lembrete: (n, a) => `Oi, ${n}! Passando para lembrar do seu ensaio de Natal ${a.date === hojeISO() ? "hoje" : a.date === maisDias(hojeISO(), 1) ? "amanhã" : "em " + diaBR(a.date)}, às ${a.time}. Estou te esperando! 🎄`,
    fotos_prontas: (n) => `Oi, ${n}! Suas fotos de Natal estão prontas! 🎄 Vou te enviar o link para você ver e baixar. Espero que ame tanto quanto eu amei fazer.`,
    depoimento: (n) => `Oi, ${n}! Foi um prazer fotografar vocês. Se puder, me conta em poucas palavras como foi a experiência? Seu depoimento ajuda muito o meu trabalho. 💛`,
  };

  /* ---------- ferramentas (só leitura; ações viram botões) ---------- */
  const FERRAMENTAS = {
    agenda({ de, ate }) {
      const ini = okDia(de) ? de : hojeISO();
      const fim = okDia(ate) && ate >= ini ? ate : ini;
      const l = ativos().filter(a => a.date >= ini && a.date <= fim).sort(ordem);
      return { forModel: { de: diaBR(ini), ate: diaBR(fim), total: l.length, ensaios: l.slice(0, 60).map(resumo) } };
    },
    pedidos_pendentes() {
      const l = (appointmentsCache || []).filter(a => a.status === "pendente").sort(ordem);
      return { forModel: { total: l.length, pedidos: l.slice(0, 50).map(resumo) } };
    },
    resumo_vendas() {
      const l = ativos();
      const soma = (arr, f) => arr.reduce((s, a) => s + f(a), 0);
      const grupo = (chave) => {
        const g = {};
        l.forEach(a => { const k = chave(a) || "(sem nome)"; g[k] = g[k] || { pedidos: 0, vendido: 0, recebido: 0 }; g[k].pedidos++; g[k].vendido += pgTotalDe(a); g[k].recebido += pgRecebido(a); });
        return Object.entries(g).sort((x, y) => y[1].vendido - x[1].vendido).map(([k, v]) => ({ nome: k, pedidos: v.pedidos, vendido: brl(v.vendido), recebido: brl(v.recebido) }));
      };
      const vendido = soma(l, pgTotalDe), recebido = soma(l, pgRecebido);
      return { forModel: {
        pedidos_ativos: l.length,
        confirmados: l.filter(a => a.status === "confirmado").length,
        pendentes: l.filter(a => a.status === "pendente").length,
        cancelados: (appointmentsCache || []).length - l.length,
        vendido: brl(vendido), recebido: brl(recebido), falta_receber: brl(Math.max(0, vendido - recebido)),
        quitados: l.filter(a => pgSituacaoDe(a) === "quitado").length,
        so_sinal: l.filter(a => pgSituacaoDe(a) === "sinal").length,
        sem_pagamento: l.filter(a => pgSituacaoDe(a) === "aberto").length,
        ticket_medio: l.length ? brl(vendido / l.length) : "sem pedidos",
        por_pacote: grupo(a => a.package), por_lote: grupo(a => a.lot),
      } };
    },
    pagamentos_pendentes() {
      const l = ativos().filter(a => pgSituacaoDe(a) !== "quitado").sort(ordem).slice(0, 40);
      const itens = l.map(a => Object.assign(resumo(a), { falta: brl(Math.max(0, pgTotalDe(a) - pgRecebido(a))) }));
      const cobrar = l.filter(a => a.phone).map(a => {
        const falta = brl(Math.max(0, pgTotalDe(a) - pgRecebido(a)));
        const oQue = pgSituacaoDe(a) === "sinal" ? "do restante do pagamento" : "do pagamento do sinal";
        const txt = `Oi, ${primeiro(a.name)}! Tudo bem? Passando para lembrar ${oQue} do seu ensaio de Natal (${diaBR(a.date)} às ${a.time}). Valor em aberto: ${falta}. Qualquer dúvida, estou à disposição! 💌`;
        return { label: `Cobrar ${primeiro(a.name)} (${falta})`, href: zap(a.phone, txt) };
      });
      return { forModel: { total: itens.length, pagamentos: itens }, ui: { links: cobrar } };
    },
    cliente({ nome }) {
      const l = (appointmentsCache || []).filter(a => mesmoNome(a.name, nome)).sort(ordem);
      if (!l.length) return { forModel: { encontrado: false } };
      return { forModel: { encontrado: true, pedidos: l.slice(0, 10).map(a => Object.assign(resumo(a), { email: a.email || "", adicionais: a.addonsValor || "", observacoes: a.notes || "" })) } };
    },
    horarios_livres({ data }) {
      const dia = okDia(data) ? data : hojeISO();
      const grade = timesForDate(dia);
      const ocupados = new Set(ativos().filter(a => a.date === dia).map(a => a.time));
      return { forModel: {
        data: semana(dia) + " " + diaBR(dia),
        dentro_da_temporada: dia >= CONFIG.seasonStart && dia <= CONFIG.seasonEnd,
        atende_neste_dia: grade.length > 0,
        horarios_livres: grade.filter(t => !ocupados.has(t)),
        ocupados: grade.filter(t => ocupados.has(t)),
      } };
    },
    lista_vip() {
      const s = vipSettings || {};
      return { forModel: { vip_ligado: !!s.vipEnabled, lancado: !!s.vipLaunchAt, inscritos: (vipSignups || []).length || vipCount || 0 } };
    },
    mensagem_whatsapp({ cliente, tipo }) {
      const l = ativos().filter(a => mesmoNome(a.name, cliente)).sort(ordem);
      if (!l.length) return { forModel: { ok: false, motivo: "Cliente não encontrada na agenda." } };
      const a = l.find(x => x.date >= hojeISO()) || l[l.length - 1];
      if (!a.phone) return { forModel: { ok: false, motivo: "Essa cliente não tem WhatsApp no pedido." } };
      const txt = (MENSAGENS[tipo] || MENSAGENS.lembrete)(primeiro(a.name), a);
      return { forModel: { ok: true, cliente: a.name, mensagem: txt }, ui: { links: [{ label: `Enviar para ${primeiro(a.name)} no WhatsApp`, href: zap(a.phone, txt) }] } };
    },
    preparar_confirmacao({ cliente }) {
      const l = (appointmentsCache || []).filter(a => a.status === "pendente" && mesmoNome(a.name, cliente)).sort(ordem);
      if (!l.length) return { forModel: { ok: false, motivo: "Não há pedido pendente com esse nome." } };
      return { forModel: { ok: true, pedidos: l.map(resumo), observacao: "O botão de confirmar aparece abaixo da resposta." },
        ui: { actions: l.slice(0, 3).map(a => ({ kind: "confirm", id: a.id, label: `Confirmar ${primeiro(a.name)} · ${diaBR(a.date)} ${a.time}` })) } };
    },
    preparar_pagamento({ cliente, marco, valor_reais }) {
      const l = ativos().filter(a => mesmoNome(a.name, cliente) && pgSituacaoDe(a) !== "quitado").sort(ordem);
      if (!l.length) return { forModel: { ok: false, motivo: "Não encontrei pedido em aberto com esse nome." } };
      const a = l[0];
      const ehSinal = marco === "sinal";
      if (ehSinal && a.pagoSinal) return { forModel: { ok: false, motivo: "O sinal dessa cliente já está marcado. Talvez seja a quitação." } };
      const sugerido = ehSinal ? pgSinalEsperado(a) : Math.max(0, pgTotalDe(a) - pgRecebido(a));
      const valor = Number(valor_reais) > 0 ? Number(valor_reais) : sugerido;
      return { forModel: { ok: true, cliente: a.name, ensaio: diaBR(a.date) + " " + a.time, total: brl(pgTotalDe(a)), ja_recebido: brl(pgRecebido(a)), valor_do_botao: brl(valor), observacao: "O botão de registrar aparece abaixo da resposta." },
        ui: { actions: [{ kind: "pay", id: a.id, marco: ehSinal ? "sinal" : "total", valor: Math.round(valor * 100) / 100,
          label: (ehSinal ? "Marcar sinal de " : "Marcar quitado (") + brl(valor) + (ehSinal ? "" : ")") + " · " + primeiro(a.name) }] } };
    },
  };

  /* ---------- conversa com a função ---------- */
  async function chamarApi(messages) {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : "";
    const hoje = hojeISO();
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ messages, context: { today: hoje, weekday: semana(hoje), season: diaBR(CONFIG.seasonStart) + " a " + diaBR(CONFIG.seasonEnd) } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "A Polaroidy não respondeu agora.");
    return data;
  }

  async function perguntar(historico, pergunta) {
    const messages = historico.concat([{ role: "user", content: pergunta }]);
    const ui = { links: [], actions: [] };
    for (let volta = 0; volta < 5; volta++) {
      const res = await chamarApi(messages);
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "refusal") return { historico: messages, texto: "Não consigo ajudar com isso. Tente perguntar de outro jeito.", ui };
      if (res.stop_reason !== "tool_use") {
        const texto = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        return { historico: messages, texto: texto || "Pronto.", ui };
      }
      const resultados = res.content.filter(b => b.type === "tool_use").map(c => {
        try {
          const fn = FERRAMENTAS[c.name];
          if (!fn) throw new Error("Ferramenta desconhecida.");
          const out = fn(c.input || {});
          if (out.ui && out.ui.links) ui.links.push(...out.ui.links);
          if (out.ui && out.ui.actions) ui.actions.push(...out.ui.actions);
          return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out.forModel) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Não foi possível ler esses dados: " + (e.message || "erro") };
        }
      });
      messages.push({ role: "user", content: resultados });
    }
    return { historico: messages, texto: "Essa pergunta ficou complicada demais. Pode tentar de um jeito mais simples?", ui };
  }

  async function executarAcao(a) {
    if (a.kind === "confirm") {
      const ok = await updateAppointmentStatus(a.id, "confirmado");
      if (!ok) throw new Error("Não consegui confirmar agora.");
      return "Pedido confirmado.";
    }
    if (a.kind === "pay") {
      const data = await apiPost({ action: "updatePagamento", id: a.id, marco: a.marco, pago: true, valor: a.valor }, true);
      if (data && data.reason === "unauthorized") { handleUnauthorized(); throw new Error("Sessão expirada."); }
      if (!data || !data.ok) throw new Error("Não consegui registrar agora.");
      const i = appointmentsCache.findIndex(x => x.id === a.id);
      if (i > -1) Object.assign(appointmentsCache[i], data.campos || {});
      return "Pagamento de " + brl(a.valor) + " registrado.";
    }
    throw new Error("Ação desconhecida.");
  }

  /* ---------- interface ---------- */
  const CSS = `
  #pldy-fab{position:fixed;right:20px;bottom:20px;z-index:900;display:flex;align-items:center;gap:8px;padding:8px 16px 8px 8px;border:none;border-radius:999px;background:var(--vinho,#6b1e2a);color:#fff;font:600 14px/1 var(--sans,system-ui);box-shadow:0 8px 24px rgba(0,0,0,.22);cursor:pointer}
  #pldy-fab img{width:34px;height:34px;border-radius:50%;background:#fff}
  #pldy-panel{position:fixed;right:20px;bottom:20px;z-index:950;width:min(400px,calc(100vw - 32px));height:min(620px,calc(100vh - 40px));display:none;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.28);overflow:hidden;font-family:var(--sans,system-ui)}
  #pldy-panel.open{display:flex}
  .pldy-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--vinho,#6b1e2a);color:#fff}
  .pldy-head img{width:36px;height:36px;border-radius:50%;background:#fff}
  .pldy-head b{display:block;font-size:15px}.pldy-head small{opacity:.75;font-size:11.5px}
  .pldy-head button{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1}
  .pldy-msgs{flex:1;overflow-y:auto;padding:14px;background:var(--marfim,#f6f1e7);display:flex;flex-direction:column;gap:10px}
  .pldy-b{max-width:88%;padding:10px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:normal;word-wrap:break-word}
  .pldy-b.eu{align-self:flex-end;background:var(--vinho,#6b1e2a);color:#fff;border-bottom-right-radius:4px}
  .pldy-b.ela{align-self:flex-start;background:#fff;color:#1b1712;border:1px solid rgba(27,23,18,.08);border-bottom-left-radius:4px}
  .pldy-b.ela ul{margin:4px 0 0 18px;padding:0}.pldy-b p{margin:0 0 4px}
  .pldy-b.erro{background:#fbeaea;color:#a23a3a}
  .pldy-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .pldy-btns a,.pldy-btns button{font:600 12.5px/1.2 var(--sans,system-ui);padding:7px 10px;border-radius:8px;border:1px solid var(--vinho,#6b1e2a);background:#fff;color:var(--vinho,#6b1e2a);text-decoration:none;cursor:pointer}
  .pldy-btns a.zap{border-color:#25a244;color:#1d7f35}
  .pldy-btns button:disabled{opacity:.55;cursor:default}
  .pldy-sug{display:flex;flex-wrap:wrap;gap:6px}
  .pldy-sug button{font-size:12.5px;padding:6px 10px;border-radius:999px;border:1px solid rgba(27,23,18,.15);background:#fff;cursor:pointer}
  .pldy-form{display:flex;gap:8px;padding:10px;border-top:1px solid rgba(27,23,18,.08);background:#fff}
  .pldy-form textarea{flex:1;resize:none;border:1px solid rgba(27,23,18,.15);border-radius:10px;padding:9px 10px;font:14px/1.35 var(--sans,system-ui);max-height:110px}
  .pldy-form button{border:none;border-radius:10px;padding:0 14px;background:var(--vinho,#6b1e2a);color:#fff;font-weight:600;cursor:pointer}
  .pldy-form button:disabled{opacity:.5}
  .pldy-novo{font-size:11.5px;background:none;border:none;color:rgba(27,23,18,.5);cursor:pointer;align-self:center;text-decoration:underline}
  @media (max-width:600px){#pldy-panel{right:0;bottom:0;width:100vw;height:100dvh;border-radius:0}#pldy-fab{right:14px;bottom:14px}}`;

  const SUGESTOES = ["O que tenho hoje?", "Pedidos aguardando confirmação", "Quem ainda não pagou?", "Quanto já vendi na temporada?", "Tenho horário livre amanhã?"];

  let historico = [];
  let ocupada = false;
  let msgs, entrada, enviar;

  function inline(txt) {
    return escapeHtml(txt).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  }
  function formatar(texto) {
    const linhas = String(texto).split("\n");
    let html = "", lista = false;
    linhas.forEach(l => {
      const m = l.match(/^\s*[-•]\s+(.*)$/);
      if (m) { if (!lista) { html += "<ul>"; lista = true; } html += "<li>" + inline(m[1]) + "</li>"; return; }
      if (lista) { html += "</ul>"; lista = false; }
      if (l.trim()) html += "<p>" + inline(l) + "</p>";
    });
    if (lista) html += "</ul>";
    return html;
  }
  function rolar() { msgs.scrollTop = msgs.scrollHeight; }
  function bolha(classe, html) {
    const d = document.createElement("div");
    d.className = "pldy-b " + classe;
    d.innerHTML = html;
    msgs.appendChild(d); rolar();
    return d;
  }

  function botoes(el, ui) {
    if (!ui.links.length && !ui.actions.length) return;
    const box = document.createElement("div");
    box.className = "pldy-btns";
    ui.links.forEach(l => {
      const a = document.createElement("a");
      a.href = l.href; a.target = "_blank"; a.rel = "noopener"; a.className = "zap"; a.textContent = l.label;
      box.appendChild(a);
    });
    ui.actions.forEach(ac => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = ac.label;
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const msg = await executarAcao(ac);
          b.textContent = "✓ " + msg;
          showToast(msg, "success");
          try { refreshAdminData(true); } catch (e) {}
        } catch (e) {
          b.disabled = false;
          showToast(e.message || "Não deu certo.", "error");
        }
      });
      box.appendChild(b);
    });
    el.appendChild(box); rolar();
  }

  async function mandar(pergunta) {
    pergunta = String(pergunta || "").trim();
    if (!pergunta || ocupada) return;
    if (!API) { bolha("ela erro", "A Polaroidy ainda não foi configurada: falta o endereço da função (CONFIG.polaroidyApi)."); return; }
    ocupada = true; enviar.disabled = true; entrada.value = "";
    const sug = msgs.querySelector(".pldy-sug"); if (sug) sug.remove();
    bolha("eu", escapeHtml(pergunta));
    const pensando = bolha("ela", "<i>Pensando…</i>");
    try {
      const r = await perguntar(historico, pergunta);
      historico = r.historico;
      pensando.innerHTML = formatar(r.texto);
      botoes(pensando, r.ui);
    } catch (e) {
      pensando.className = "pldy-b ela erro";
      pensando.textContent = e.message || "A Polaroidy não respondeu agora.";
    } finally {
      ocupada = false; enviar.disabled = false; entrada.focus(); rolar();
    }
  }

  function boasVindas() {
    msgs.innerHTML = "";
    historico = [];
    const hoje = hojeISO();
    const deHoje = ativos().filter(a => a.date === hoje).sort(ordem);
    const pend = (appointmentsCache || []).filter(a => a.status === "pendente").length;
    let txt = "Oi, Taíse! Sou a **Polaroidy**, sua assistente. 📸\n";
    txt += deHoje.length ? "- Hoje: **" + deHoje.map(a => a.time + " " + primeiro(a.name)).join(", ") + "**\n" : "- Nenhum ensaio hoje.\n";
    if (pend) txt += "- **" + pend + "** pedido" + (pend > 1 ? "s" : "") + " aguardando confirmação\n";
    txt += "Pergunte sobre agenda, pagamentos, vendas ou peça um texto.";
    bolha("ela", formatar(txt));
    const s = document.createElement("div");
    s.className = "pldy-sug";
    SUGESTOES.forEach(q => { const b = document.createElement("button"); b.type = "button"; b.textContent = q; b.addEventListener("click", () => mandar(q)); s.appendChild(b); });
    msgs.appendChild(s);
  }

  function montar() {
    const view = document.getElementById("admin-view");
    if (!view || document.getElementById("pldy-fab")) return;
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    const icone = "polaroidy.svg";

    const fab = document.createElement("button");
    fab.id = "pldy-fab"; fab.type = "button";
    fab.innerHTML = `<img src="${icone}" alt="">Polaroidy`;
    view.appendChild(fab);

    const p = document.createElement("div");
    p.id = "pldy-panel"; p.setAttribute("role", "dialog"); p.setAttribute("aria-label", "Polaroidy, assistente com IA");
    p.innerHTML = `
      <div class="pldy-head"><img src="${icone}" alt=""><div><b>Polaroidy</b><small>Assistente com IA · confira antes de agir</small></div><button type="button" aria-label="Fechar">×</button></div>
      <div class="pldy-msgs"></div>
      <form class="pldy-form"><textarea rows="1" placeholder="Pergunte algo…" aria-label="Pergunta"></textarea><button type="submit">Enviar</button></form>
      <button type="button" class="pldy-novo">Nova conversa</button>`;
    view.appendChild(p);
    msgs = p.querySelector(".pldy-msgs");
    entrada = p.querySelector("textarea");
    enviar = p.querySelector(".pldy-form button");

    fab.addEventListener("click", () => {
      p.classList.add("open"); fab.style.display = "none";
      if (!historico.length) boasVindas();
      entrada.focus();
    });
    p.querySelector(".pldy-head button").addEventListener("click", () => { p.classList.remove("open"); fab.style.display = ""; });
    p.querySelector(".pldy-novo").addEventListener("click", () => { if (!ocupada) boasVindas(); });
    p.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); mandar(entrada.value); });
    entrada.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); mandar(entrada.value); } });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", montar); else montar();
})();
