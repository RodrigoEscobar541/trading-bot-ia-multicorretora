// app.js — painel web V2 (multi-plataforma / multi-ativo).
//
// Lê e escreve DIRETO no Firestore (árvore plataformas/{P}/ativos/{A}/...),
// atrás de Firebase Auth. As chaves de API nunca são exibidas — apenas
// gravadas; a interface mostra placeholder mascarado.
//
// Navegação: menu lateral (hambúrguer no mobile) com Visão geral, uma entrada
// por ativo e a tela da plataforma. Rota no hash: #/geral, #/ativo/MB/BTC,
// #/plataforma/MB.
//
// Gráficos: SVG puro gerado aqui (linha 2px, grade hairline, crosshair +
// tooltip, tabela de dados como alternativa). Texto de terceiros
// (justificativas da IA) entra no DOM só via textContent — nunca innerHTML.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, onSnapshot, setDoc, deleteDoc, getDocs, collection, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig, firestoreDatabaseId } from './firebase-config.js';
import { estadoLimite, registrarFalha, mensagemErro, ESTADO_ZERADO } from './limiteLogin.js';
import { somarOrcamentos, textoOrcamento } from './orcamentos.js';
import { consolidarPatrimonio } from './patrimonio.js';
import { estadoConexao, resumoConexao } from './conexaoStatus.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = firestoreDatabaseId ? getFirestore(app, firestoreDatabaseId) : getFirestore(app);

// Único usuário autorizado a usar o painel. As regras do Firestore
// (firestore.rules) impõem o mesmo UID no servidor — esta checagem é só a
// camada de interface (mensagem clara em vez de erros de permissão).
const UID_AUTORIZADO = 'COLE_AQUI_O_UID_DO_DONO';

const $ = (id) => document.getElementById(id);

/**
 * Esconde/mostra uma seção pelo id, tolerando que ela NÃO EXISTA.
 *
 * Existe por causa de um incidente real (2026-08-05): o Firebase Hosting servia
 * o HTML com cache de 1 h e o JS sem cache, então um deploy podia entregar o
 * script NOVO rodando sobre a página VELHA. O script tentava esconder uma seção
 * que aquele HTML ainda não tinha, dava TypeError no meio da navegação, e a
 * tela anterior ficava na frente do dono — com aparência de bug de conteúdo,
 * não de cache. O cabeçalho foi corrigido no `firebase.json`; isto aqui é o
 * cinto de segurança, para a próxima divergência degradar em vez de derrubar.
 */
const mostrarSecao = (id, visivel) => {
  const el = $(id);
  if (el) el.hidden = !visivel;
};

/** `addEventListener` que ignora elemento ausente — mesma razão de `mostrarSecao`. */
const aoEvento = (id, evento, fn) => {
  const el = $(id);
  if (el) el.addEventListener(evento, fn);
};

// ------------------------------------------------------------- formatadores
// Cada plataforma tem a SUA moeda (MB = BRL, TT = USD): os formatadores são
// criados sob demanda por moeda; `moedaTela` acompanha a plataforma da rota.
const formatadores = new Map(); // moeda → { cheio, compacto }
function fmtMoeda(moeda = 'BRL') {
  if (!formatadores.has(moeda)) {
    formatadores.set(moeda, criarFormatadores(moeda));
  }
  return formatadores.get(moeda);
}

/**
 * Formatadores de uma moeda. `Intl` só aceita código ISO de 3 letras e LANÇA
 * em qualquer outro — e nem toda "moeda" deste sistema é ISO: a carteira Steam
 * é `BRLS`, deliberadamente diferente de `BRL` para que nada some as duas.
 * Sem este fallback, abrir a tela de um item da Steam quebraria a página
 * inteira num RangeError.
 */
function criarFormatadores(moeda) {
  try {
    return {
      cheio: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda }),
      compacto: new Intl.NumberFormat('pt-BR', {
        style: 'currency', currency: moeda, notation: 'compact', maximumFractionDigits: 1,
      }),
    };
  } catch {
    // Moeda fora do padrão ISO: número no formato local, com o código na frente.
    const numero = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const compacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
    return {
      cheio: { format: (v) => `${moeda} ${numero.format(v)}` },
      compacto: { format: (v) => `${moeda} ${compacto.format(v)}` },
    };
  }
}
let moedaTela = 'BRL'; // moeda da plataforma exibida (atualizada pela rota)
const dinheiro = (v, moeda = moedaTela) =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : fmtMoeda(moeda).cheio.format(v);
const qtd = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(8).replace(/\.?0+$/, '') || '0');
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(2)}%`);
// % do CDI sem zeros à direita ("106%", "106,5%") para título/coluna/rodapé.
const pctCdi = (v) =>
  v === null || v === undefined ? '—' : `${Number(v).toFixed(2).replace(/\.?0+$/, '')}%`;
const dataHora = (iso) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
// Dia solto ('YYYY-MM-DD') → 'DD/MM'. Fatiado na string de propósito: passar por
// `new Date` trataria o dia como meia-noite UTC e mostraria o dia ANTERIOR no
// fuso de Brasília.
const dataDia = (dia) =>
  typeof dia === 'string' && dia.length >= 10 ? `${dia.slice(8, 10)}/${dia.slice(5, 7)}` : '—';

// --------------------------------------------------------------------- login
// O freio de tentativas (limiteLogin.js) NÃO é defesa contra força bruta — ele
// roda no navegador. Ele existe para o DONO não tropeçar no bloqueio por IP do
// Firebase, que é cego (não distingue atacante de quem errou a senha três vezes)
// e some numa hora que ninguém informa. Ver o cabeçalho de limiteLogin.js.
const CHAVE_LIMITE = 'ia_investidora_login';

const lerLimite = () => {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_LIMITE) ?? 'null');
  } catch {
    return null; // storage corrompido nunca tranca o dono
  }
};
const gravarLimite = (estado) => {
  try {
    localStorage.setItem(CHAVE_LIMITE, JSON.stringify(estado));
  } catch {
    /* modo privado / storage cheio: o freio simplesmente não persiste */
  }
};

let tiqueLimite = null;
function renderLimite() {
  const bruto = lerLimite();
  const { bloqueado, faltam_s, estado } = estadoLimite(bruto);
  // Persiste SÓ quando o esquecimento zerou o contador — não a cada tique da
  // contagem regressiva, que reescreveria o storage uma vez por segundo.
  if (bruto?.falhas > 0 && estado.falhas === 0) gravarLimite(estado);
  $('botao-login').disabled = bloqueado;

  if (bloqueado) {
    $('login-erro').textContent = faltam_s > 60
      ? `Muitas tentativas. Aguarde ${Math.ceil(faltam_s / 60)} min para tentar de novo.`
      : `Muitas tentativas. Aguarde ${faltam_s}s para tentar de novo.`;
    $('login-erro').hidden = false;
    // Um tique por segundo só enquanto há bloqueio — nada roda em tela parada.
    if (!tiqueLimite) tiqueLimite = setInterval(renderLimite, 1000);
  } else if (tiqueLimite) {
    clearInterval(tiqueLimite);
    tiqueLimite = null;
    $('login-erro').hidden = true;
  }
  return bloqueado;
}

$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (renderLimite()) return; // ainda de castigo
  $('login-erro').hidden = true;
  $('botao-login').disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $('login-email').value, $('login-senha').value);
    gravarLimite({ ...ESTADO_ZERADO }); // acertou: o contador some
  } catch (e) {
    gravarLimite(registrarFalha(lerLimite()));
    const bloqueado = renderLimite();
    if (!bloqueado) {
      $('login-erro').textContent = mensagemErro(e.code);
      $('login-erro').hidden = false;
    }
  } finally {
    if (!tiqueLimite) $('botao-login').disabled = false;
  }
});

renderLimite(); // recarregar a página não zera o castigo
$('botao-sair').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (usuario) => {
  if (usuario && usuario.uid !== UID_AUTORIZADO) {
    signOut(auth);
    $('login-erro').textContent = 'Esta conta não tem acesso ao painel.';
    $('login-erro').hidden = false;
    return;
  }
  const logado = Boolean(usuario);
  $('tela-login').hidden = logado;
  $('painel').hidden = !logado;
  if (logado) {
    $('usuario-email').textContent = usuario.email ?? '';
    assinarGlobais();
    aplicarRota();
  } else {
    cancelarTudo();
  }
});

// ------------------------------------------------------------ estado global
// plataformas: id → { dados, ativos: Map, porAtivo: Map(id → { dashboard,
// estado, estatisticas: { simulacao, real } }) }
const plataformas = new Map();
let rendaReal = null; // doc global/renda_real (comparativo com 106% do CDI)
let statusBot = null; // doc global/status_bot (heartbeat do processo do bot)
let controle = null; // doc global/controle (parada de emergência — V6.2)
let cambio = null; // doc global/cambio (consolidação do patrimônio em BRL — V6.2)
let configRenda = null; // doc global/config_renda (Selic/% do CDI manuais — V6.5)
let rendaModo = 'real'; // aba do comparativo × CDI: 'real' | 'simulacao'
const cancelGlobais = [];
const cancelPorPlataforma = new Map(); // plataformaId → [unsub...]
let cancelTela = []; // assinaturas da tela selecionada (historico/ops/posicoes/prompt/contexto/api/template)

function cancelarTudo() {
  while (cancelGlobais.length) cancelGlobais.pop()();
  for (const lista of cancelPorPlataforma.values()) lista.forEach((fn) => fn());
  cancelPorPlataforma.clear();
  cancelTela.forEach((fn) => fn());
  cancelTela = [];
  plataformas.clear();
}

/**
 * Avisa o BOT de que um documento de CONFIGURAÇÃO acabou de mudar (V8.14).
 *
 * O bot guarda plataformas, chaves, ativos e camadas do prompt num cache de 15
 * min (`src/nucleo/catalogo.js`) — TTL alto de propósito, porque reler tudo a
 * cada 5 min custava ~8 mil leituras/dia e a quota gratuita já estourou uma vez
 * por causa disso. Sem este aviso, salvar uma config e esperar até 15 min seria
 * o preço; com ele, o bot descarta o cache no próximo minuto.
 *
 * Grava uma MARCA (um ISO) em `global/controle`, o mesmo doc do "atualizar
 * inventário agora" e da parada de emergência: nenhuma leitura nova no tick do
 * bot, que já recebe esse documento por listener.
 *
 * MELHOR ESFORÇO: falhar aqui não pode transformar um "salvo ✓" em erro — a
 * configuração JÁ foi gravada, e o TTL de 15 min continua sendo a rede de
 * segurança. Por isso não lança e não é esperado por quem chama.
 */
function avisarConfigMudou() {
  setDoc(
    doc(db, 'global', 'controle'),
    { catalogo_invalidado_em: new Date().toISOString() },
    { merge: true },
  ).catch(() => {});
}

const modoDoAtivo = (ativo) => (ativo?.config?.modo_simulacao === false ? 'real' : 'simulacao');
// Plataforma ASSISTIDA (ex.: Toro, sem API): o robô só RECOMENDA — quem
// executa e registra as operações é o dono.
const plataformaAssistida = (pid) => plataformas.get(pid)?.dados?.assistida === true;

function assinarGlobais() {
  cancelGlobais.push(
    // Comparativo de renda real × 106% do CDI (escrito pelo bot a cada 15 min).
    onSnapshot(doc(db, 'global', 'renda_real'), (snap) => {
      rendaReal = snap.data() ?? null;
      if (rota.tipo === 'geral') renderRendaReal();
    }),
    // Heartbeat do bot (escrito a cada ~1 min): diz se o processo está vivo.
    onSnapshot(doc(db, 'global', 'status_bot'), (snap) => {
      statusBot = snap.data() ?? null;
      renderStatusBot();
      if (rota.tipo === 'geral') {
        renderControle();
        renderControleIA(); // o bot confirma o kill-switch da IA pelo heartbeat
        renderTelegramStatus(); // o resultado do último envio vem no heartbeat
      }
    }),
    // Parada de emergência (V6.2) + kill-switch da IA (V8.10): o mesmo doc.
    onSnapshot(doc(db, 'global', 'controle'), (snap) => {
      controle = snap.data() ?? null;
      if (rota.tipo === 'geral') {
        renderControle();
        renderControleIA();
      }
    }),
    // Câmbio USD→BRL (V6.2): consolida o patrimônio da visão geral em BRL.
    onSnapshot(doc(db, 'global', 'cambio'), (snap) => {
      cambio = snap.data() ?? null;
      if (rota.tipo === 'geral') renderGeral();
    }),
    // Ajustes manuais do comparativo × CDI (V6.5): Selic e % do CDI editáveis.
    onSnapshot(doc(db, 'global', 'config_renda'), (snap) => {
      configRenda = snap.data() ?? null;
      if (rota.tipo === 'geral') renderRendaReal();
    }),
    // Avisos no Telegram (V7): token/chat/toggles. O token só é ESCRITO daqui;
    // nunca é exibido de volta na tela.
    onSnapshot(doc(db, 'global', 'telegram'), (snap) => {
      renderTelegram(snap.data() ?? null);
    }),
    onSnapshot(collection(db, 'plataformas'), (snap) => {
      const idsAtuais = new Set(snap.docs.map((d) => d.id));
      for (const d of snap.docs) {
        if (!plataformas.has(d.id)) {
          plataformas.set(d.id, { dados: d.data(), ativos: new Map(), porAtivo: new Map() });
          assinarPlataforma(d.id);
        } else {
          plataformas.get(d.id).dados = d.data();
        }
      }
      for (const id of [...plataformas.keys()]) {
        if (!idsAtuais.has(id)) {
          (cancelPorPlataforma.get(id) ?? []).forEach((fn) => fn());
          cancelPorPlataforma.delete(id);
          plataformas.delete(id);
        }
      }
      renderMenu();
      renderTudoDaRota();
    }),
  );
}

function assinarPlataforma(pid) {
  const cancelamentos = [];
  cancelPorPlataforma.set(pid, cancelamentos);
  const p = plataformas.get(pid);

  cancelamentos.push(
    onSnapshot(collection(db, 'plataformas', pid, 'ativos'), (snap) => {
      const ids = new Set(snap.docs.map((d) => d.id));
      for (const d of snap.docs) {
        p.ativos.set(d.id, d.data());
        if (!p.porAtivo.has(d.id)) {
          p.porAtivo.set(d.id, { dashboard: null, estado: null, estatisticas: { simulacao: null, real: null } });
          assinarAtivoLeve(pid, d.id, cancelamentos);
        }
      }
      for (const id of [...p.ativos.keys()]) if (!ids.has(id)) p.ativos.delete(id);
      renderMenu();
      renderTudoDaRota();
    }),
    onSnapshot(doc(db, 'plataformas', pid, 'dados', 'estado'), (snap) => {
      p.estadoPlataforma = snap.data() ?? null;
      renderMenu(); // atualiza o sinal de conexão da plataforma
      renderTudoDaRota();
    }),
  );
}

/** Docs leves de cada ativo, usados pela visão geral E pela tela do ativo. */
function assinarAtivoLeve(pid, aid, cancelamentos) {
  const alvo = () => plataformas.get(pid)?.porAtivo.get(aid);
  const base = ['plataformas', pid, 'ativos', aid, 'dados'];
  cancelamentos.push(
    onSnapshot(doc(db, ...base, 'dashboard'), (snap) => { const a = alvo(); if (a) { a.dashboard = snap.data() ?? null; renderTudoDaRota(); } }),
    onSnapshot(doc(db, ...base, 'estado'), (snap) => { const a = alvo(); if (a) { a.estado = snap.data() ?? null; renderTudoDaRota(); } }),
    onSnapshot(doc(db, ...base, 'estatisticas_simulacao'), (snap) => { const a = alvo(); if (a) { a.estatisticas.simulacao = snap.data() ?? null; renderTudoDaRota(); } }),
    onSnapshot(doc(db, ...base, 'estatisticas_real'), (snap) => { const a = alvo(); if (a) { a.estatisticas.real = snap.data() ?? null; renderTudoDaRota(); } }),
  );
}

// ------------------------------------------------------------------- rotas
// A Steam tem tela PRÓPRIA (não a de plataforma): o que interessa nela é o
// inventário com foto e o check por item, não chaves de corretora.
const PLATAFORMA_STEAM = 'STEAM';

let rota = { tipo: 'geral' };

function aplicarRota() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (partes[0] === 'ativo' && partes[1] && partes[2]) {
    rota = { tipo: 'ativo', plataforma: partes[1], ativo: partes[2] };
  } else if (partes[0] === 'plataforma' && partes[1]) {
    rota = { tipo: 'plataforma', plataforma: partes[1] };
  } else if (partes[0] === 'parametros') {
    rota = { tipo: 'parametros' };
  } else if (partes[0] === 'regras') {
    rota = { tipo: 'regras' };
  } else if (partes[0] === 'supervisao') {
    rota = { tipo: 'supervisao' };
  } else if (partes[0] === 'steam') {
    rota = { tipo: 'steam', plataforma: PLATAFORMA_STEAM };
  } else {
    rota = { tipo: 'geral' };
  }

  mostrarSecao('tela-geral', rota.tipo === 'geral');
  mostrarSecao('tela-ativo', rota.tipo === 'ativo');
  mostrarSecao('tela-plataforma', rota.tipo === 'plataforma');
  mostrarSecao('tela-parametros', rota.tipo === 'parametros');
  mostrarSecao('tela-regras', rota.tipo === 'regras');
  mostrarSecao('tela-supervisao', rota.tipo === 'supervisao');
  mostrarSecao('tela-steam', rota.tipo === 'steam');
  fecharMenuMobile();
  assinarTela();
  garantirSeriePatrimonio(); // fora da tela da plataforma, só cancela o que havia
  renderMenu();
  renderTudoDaRota();
}
window.addEventListener('hashchange', aplicarRota);

/** Assinaturas específicas da tela atual (trocadas a cada navegação). */
let telaDados = {}; // historico, operacoes, posicoes, prompt, contexto, api, template, contas
// Contas espelho já assinadas nesta tela (V8.18) — a lista chega por snapshot,
// e cada conta traz dois docs próprios.
let contasAssinadas = new Set();
let assinarDocsDasContas = () => {};
function assinarTela() {
  cancelTela.forEach((fn) => fn());
  cancelTela = [];
  contasAssinadas = new Set();
  assinarDocsDasContas = () => {};
  // A série do patrimônio da plataforma tem cancelamento próprio: ela é assinada
  // por ATIVO e refeita quando a lista de ativos chega (que é depois da rota).
  cancelarPatrimonio();
  telaDados = {};
  if (!auth.currentUser) return;

  if (rota.tipo === 'ativo') {
    const base = ['plataformas', rota.plataforma, 'ativos', rota.ativo];
    cancelTela.push(
      onSnapshot(query(collection(db, ...base, 'historico'), orderBy('horario', 'desc'), limit(150)), (snap) => {
        telaDados.historico = snap.docs.map((d) => d.data()).reverse();
        renderGraficos();
      }),
      onSnapshot(query(collection(db, ...base, 'operacoes'), orderBy('horario', 'desc'), limit(50)), (snap) => {
        telaDados.operacoes = snap.docs.map((d) => d.data());
        renderOperacoes();
        renderGraficos(); // as operações são os marcadores do gráfico de preço
      }),
      onSnapshot(query(collection(db, ...base, 'posicoes'), orderBy('abertura', 'desc'), limit(100)), (snap) => {
        telaDados.posicoes = snap.docs.map((d) => d.data());
        renderPosicoes();
      }),
      onSnapshot(doc(db, ...base, 'dados', 'prompt'), (snap) => {
        telaDados.prompt = snap.data() ?? null;
        renderPrompt();
      }),
      onSnapshot(doc(db, ...base, 'dados', 'contexto'), (snap) => {
        telaDados.contexto = snap.data() ?? null;
        renderContexto();
      }),
    );
  } else if (rota.tipo === 'plataforma') {
    cancelTela.push(
      // ESPELHO mascarado, nunca o doc com as chaves. `dados/api` é só-escrita
      // pelas rules: o navegador grava uma credencial nova e não consegue puxar
      // nenhuma de volta. Aqui só chegam os 4 últimos caracteres, publicados
      // pelo bot em `dados/api_meta`.
      onSnapshot(doc(db, 'plataformas', rota.plataforma, 'dados', 'api_meta'), (snap) => {
        telaDados.api = snap.data()?.campos ?? null;
        renderPlataforma();
      }),
      onSnapshot(doc(db, 'plataformas', rota.plataforma, 'dados', 'template'), (snap) => {
        telaDados.template = snap.data() ?? null;
        renderTemplate();
      }),
      // CONTAS ESPELHO (V8.18): a lista, e para cada uma o estado (saldo lido
      // pelo bot) e o espelho mascarado das chaves. A `api` NUNCA é assinada —
      // ela é só-escrita, e nem as rules deixariam.
      onSnapshot(collection(db, 'plataformas', rota.plataforma, 'contas'), (snap) => {
        const anteriores = new Map((telaDados.contas ?? []).map((c) => [c.id, c]));
        telaDados.contas = snap.docs.map((d) => ({
          id: d.id,
          nome: d.data().nome ?? d.id,
          ativa: d.data().ativa !== false,
          modo_simulacao: d.data().modo_simulacao !== false,
          estado: anteriores.get(d.id)?.estado ?? null,
          apiMeta: anteriores.get(d.id)?.apiMeta ?? null,
        }));
        assinarDocsDasContas();
        renderContas();
      }),
    );
    assinarDocsDasContas = () => {
      // Re-assina o estado/api_meta de cada conta quando a lista muda. Os
      // cancelamentos entram em `cancelTela`, que já é limpo na troca de tela.
      for (const c of telaDados.contas ?? []) {
        if (contasAssinadas.has(c.id)) continue;
        contasAssinadas.add(c.id);
        const base = ['plataformas', rota.plataforma, 'contas', c.id, 'dados'];
        cancelTela.push(
          onSnapshot(doc(db, ...base, 'estado'), (snap) => {
            const alvo = (telaDados.contas ?? []).find((x) => x.id === c.id);
            if (alvo) { alvo.estado = snap.data() ?? null; renderContas(); }
          }),
          onSnapshot(doc(db, ...base, 'api_meta'), (snap) => {
            const alvo = (telaDados.contas ?? []).find((x) => x.id === c.id);
            if (alvo) { alvo.apiMeta = snap.data()?.campos ?? null; renderContas(); }
          }),
        );
        // Ordens sombra: uma coleção por (ativo, conta). Assina só os ativos que
        // a plataforma tem — é a mesma lista que já está em memória.
        telaDados.sombras ??= new Map();
        for (const aid of plataformas.get(rota.plataforma)?.ativos.keys() ?? []) {
          cancelTela.push(
            onSnapshot(
              query(
                collection(db, 'plataformas', rota.plataforma, 'ativos', aid, 'contas', c.id, 'operacoes'),
                orderBy('horario', 'desc'),
                limit(10),
              ),
              (snap) => {
                telaDados.sombras.set(`${aid}/${c.id}`, snap.docs.map((d) => d.data()));
                renderSombras();
              },
            ),
          );
        }
      }
    };
  } else if (rota.tipo === 'regras') {
    cancelTela.push(
      onSnapshot(doc(db, 'global', 'regras_gerais'), (snap) => {
        telaDados.regras = snap.data() ?? null;
        renderRegras();
      }),
      onSnapshot(doc(db, 'global', 'regras_gerais_venda'), (snap) => {
        telaDados.regrasVenda = snap.data() ?? null;
        renderRegras();
      }),
    );
  } else if (rota.tipo === 'steam') {
    cancelTela.push(
      // O retrato do inventário é publicado pelo BOT: os endpoints da Steam não
      // liberam CORS, então o navegador não consegue lê-los direto.
      onSnapshot(doc(db, 'plataformas', PLATAFORMA_STEAM, 'dados', 'inventario'), (snap) => {
        telaDados.inventario = snap.data() ?? null;
        renderSteam();
        renderSteamAlertas(); // o seletor e os preços da tabela saem daqui
      }),
      onSnapshot(doc(db, 'plataformas', PLATAFORMA_STEAM, 'dados', 'alertas'), (snap) => {
        telaDados.alertas = snap.data() ?? null;
        renderSteamAlertas();
      }),
      onSnapshot(doc(db, 'plataformas', PLATAFORMA_STEAM, 'dados', 'noticias'), (snap) => {
        telaDados.noticias = snap.data() ?? null;
        renderSteamNoticias();
      }),
      onSnapshot(doc(db, 'plataformas', PLATAFORMA_STEAM, 'dados', 'template'), (snap) => {
        telaDados.steamPrompt = snap.data() ?? null;
        renderSteamPrompt();
      }),
    );
  } else if (rota.tipo === 'supervisao') {
    cancelTela.push(
      onSnapshot(doc(db, 'global', 'supervisao'), (snap) => {
        telaDados.supervisao = snap.data() ?? null;
        renderSupervisao();
      }),
      onSnapshot(doc(db, 'global', 'supervisor'), (snap) => {
        telaDados.supervisorConfig = snap.data() ?? null;
        renderSupervisao();
      }),
      onSnapshot(doc(db, 'global', 'supervisor_prompt'), (snap) => {
        telaDados.supervisorPrompt = snap.data() ?? null;
        renderSupPrompt();
      }),
    );
  }
}

const ativoSelecionado = () =>
  rota.tipo === 'ativo' ? plataformas.get(rota.plataforma)?.ativos.get(rota.ativo) ?? null : null;
const leveSelecionado = () =>
  rota.tipo === 'ativo' ? plataformas.get(rota.plataforma)?.porAtivo.get(rota.ativo) ?? null : null;

function renderTudoDaRota() {
  moedaTela = rota.plataforma
    ? plataformas.get(rota.plataforma)?.dados?.moeda ?? 'BRL'
    : 'BRL';
  if (rota.tipo === 'geral') renderGeral();
  if (rota.tipo === 'ativo') {
    renderTiles();
    renderDecisao();
    renderAssistido();
    renderCiclo();
    renderPosicoes();
    renderGraficos();
  }
  if (rota.tipo === 'plataforma') {
    renderPlataforma();
    montarCamposContaApi(plataformas.get(rota.plataforma)?.dados?.conector);
    renderContas();
    renderSombras();
    garantirSeriePatrimonio();
    renderPatrimonioPlataforma();
  }
  if (rota.tipo === 'parametros') renderParametros();
  if (rota.tipo === 'steam') {
    renderSteam();
    renderSteamConfig();
    renderSteamAlertas();
    renderSteamNoticias();
    renderSteamPrompt();
  }
  if (rota.tipo === 'regras') renderRegras();
  if (rota.tipo === 'supervisao') {
    renderSupervisao();
    renderSupPrompt();
  }
  renderTitulo();
}

// -------------------------------------------------------------------- menu
function renderMenu() {
  const nav = $('menu-nav');
  nav.textContent = '';
  const link = (texto, hash, ativo, extra = null) => {
    const a = document.createElement('a');
    a.href = hash;
    a.textContent = texto;
    a.className = `menu-item${ativo ? ' ativo' : ''}`;
    if (extra) a.append(extra);
    return a;
  };

  nav.append(link('Visão geral', '#/geral', rota.tipo === 'geral'));
  nav.append(link('⚙ Parâmetros', '#/parametros', rota.tipo === 'parametros'));
  nav.append(link('🧠 Regras gerais da IA', '#/regras', rota.tipo === 'regras'));
  nav.append(link('🧭 Supervisão semanal', '#/supervisao', rota.tipo === 'supervisao'));
  // A Steam só aparece no menu depois de semeada pelo bot.
  if (plataformas.has(PLATAFORMA_STEAM)) {
    nav.append(link('🎮 Steam (skins do CS2)', '#/steam', rota.tipo === 'steam'));
  }

  for (const [pid, p] of plataformas) {
    // A Steam tem tela própria (acima) — não entra na lista de plataformas.
    if (pid === PLATAFORMA_STEAM) continue;
    // O NOME da plataforma é o caminho para a tela dela (V8.16). Antes havia um
    // "⚙ Plataforma e template" no fim de cada bloco: dois itens para o mesmo
    // lugar, e o de baixo ficava colado no primeiro ativo da plataforma
    // SEGUINTE, que é onde o olho errava.
    const grupo = document.createElement('a');
    grupo.href = `#/plataforma/${pid}`;
    grupo.className = `menu-grupo menu-grupo-link${rota.tipo === 'plataforma' && rota.plataforma === pid ? ' ativo' : ''}`;
    grupo.textContent = p.dados?.nome || pid;
    grupo.title = 'Abrir a configuração e o template desta plataforma';
    nav.append(grupo);

    const ordenados = [...p.ativos.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [aid, ativo] of ordenados) {
      const ligado = ativo.config?.ativo !== false;
      const marca = document.createElement('span');
      marca.className = `menu-ponto ${ligado ? 'ligado' : 'desligado'}`;
      marca.title = ligado ? 'ligado' : 'desligado';
      nav.append(
        link(
          `${ativo.manifest?.nome || aid}`,
          `#/ativo/${pid}/${aid}`,
          rota.tipo === 'ativo' && rota.plataforma === pid && rota.ativo === aid,
          marca,
        ),
      );
    }
  }
}

function renderTitulo() {
  const badge = $('badge-modo');
  if (rota.tipo === 'ativo') {
    const ativo = ativoSelecionado();
    $('titulo-tela').textContent = `${ativo?.manifest?.nome || rota.ativo} (${rota.ativo})`;
    if (ativo) {
      if (plataformaAssistida(rota.plataforma)) {
        badge.textContent = '● ASSISTIDO — você executa';
        badge.className = 'badge assistido';
      } else {
        const simulacao = modoDoAtivo(ativo) === 'simulacao';
        badge.textContent = simulacao ? '● SIMULAÇÃO' : '● MODO REAL';
        badge.className = `badge ${simulacao ? 'simulacao' : 'real'}`;
      }
      badge.hidden = false;
    } else badge.hidden = true;
  } else if (rota.tipo === 'plataforma') {
    $('titulo-tela').textContent = `Plataforma ${plataformas.get(rota.plataforma)?.dados?.nome || rota.plataforma}`;
    badge.hidden = true;
  } else if (rota.tipo === 'parametros') {
    $('titulo-tela').textContent = 'Parâmetros dos ativos';
    badge.hidden = true;
  } else if (rota.tipo === 'regras') {
    $('titulo-tela').textContent = 'Regras gerais da IA';
    badge.hidden = true;
  } else if (rota.tipo === 'supervisao') {
    $('titulo-tela').textContent = 'Supervisão semanal';
    badge.hidden = true;
  } else if (rota.tipo === 'steam') {
    $('titulo-tela').textContent = 'Steam — mercado de skins do CS2';
    badge.textContent = '● ASSISTIDO — você executa';
    badge.className = 'badge assistido';
    badge.hidden = false;
  } else {
    $('titulo-tela').textContent = 'Visão geral';
    badge.hidden = true;
  }
}

// --------------------------------------------------------- menu mobile
const abrirMenu = () => { $('menu-lateral').classList.add('aberto'); $('fundo-menu').hidden = false; };
function fecharMenuMobile() { $('menu-lateral').classList.remove('aberto'); $('fundo-menu').hidden = true; }
$('botao-menu').addEventListener('click', abrirMenu);
$('botao-fechar-menu').addEventListener('click', fecharMenuMobile);
$('fundo-menu').addEventListener('click', fecharMenuMobile);

// ------------------------------------------------------ status do bot (heartbeat)
// O bot grava global/status_bot a cada ~1 min. Se o último batimento tem menos
// de 3 min, o processo está VIVO; senão, provavelmente caiu (ou a VPS reiniciou).
const STATUS_BOT_ONLINE_MS = 3 * 60_000;

function humanizarDesde(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

function renderStatusBot() {
  const el = $('status-bot');
  if (!el) return;
  if (!statusBot?.atualizado_em) {
    el.hidden = true;
    return;
  }
  const desdeMs = Date.now() - Date.parse(statusBot.atualizado_em);
  const online = desdeMs < STATUS_BOT_ONLINE_MS;
  el.hidden = false;
  el.className = `status-bot ${online ? 'online' : 'offline'}`;
  const versao = statusBot.versao ? ` · v${statusBot.versao}` : '';
  // Qual CÓDIGO está no ar: sem isto, bot velho reiniciado e bot atualizado são
  // indistinguíveis daqui — foi o que custou uma investigação em 2026-07-25.
  const commit = statusBot.commit ? ` · ${statusBot.commit}` : '';
  const inst = statusBot.instancia && statusBot.instancia !== 'todas' ? ` · ${statusBot.instancia}` : '';
  const quando = online ? 'ativo agora' : `sem sinal ${humanizarDesde(desdeMs)}`;
  const uptime = online && statusBot.iniciado_em ? ` · no ar ${humanizarDesde(Date.now() - Date.parse(statusBot.iniciado_em))}` : '';
  el.textContent = `${online ? '🟢 Bot online' : '🔴 Bot offline'} — ${quando}${uptime}${versao}${commit}${inst}`;
}

// Reavalia sozinho (o "online" depende do tempo decorrido): sem novos
// batimentos, o selo vira offline mesmo sem chegar snapshot novo.
setInterval(renderStatusBot, 30_000);

// ------------------------------------------------ parada de emergência (V6.2)
// Botão "travar tudo": grava global/controle.operacao_travada. O bot lê esse
// flag a cada tick e pula a rodada inteira quando travado (o heartbeat segue).
function renderControle() {
  const travado = controle?.operacao_travada === true;
  const botao = $('botao-travar');
  const banner = $('banner-travado');
  const desc = $('controle-descricao');
  if (botao) {
    botao.textContent = travado ? '▶ Destravar operação' : '⛔ Travar tudo';
    botao.className = travado ? 'botao-primario' : 'botao-perigo';
  }
  if (banner) {
    banner.hidden = !travado;
    if (travado) {
      // O bot confirma a parada pelo heartbeat (status_bot.travado).
      const confirmado = statusBot?.travado === true;
      const desde = controle?.travado_em ? ` desde ${dataHora(controle.travado_em)}` : '';
      banner.textContent = `⛔ OPERAÇÃO TRAVADA${desde} — ${confirmado ? 'o bot confirmou a pausa' : 'aguardando o bot confirmar…'}`;
    }
  }
  if (desc) {
    desc.textContent = travado
      ? 'O robô está PARADO: nenhuma análise nem ordem (real ou simulação) até você destravar.'
      : 'Interrompe TODA a operação do robô (análises e ordens, real e simulação). O bot continua no ar; nenhuma ordem é enviada até destravar.';
  }
}

$('botao-travar').addEventListener('click', async () => {
  const travado = controle?.operacao_travada === true;
  const msg = travado
    ? 'Destravar e RETOMAR toda a operação do robô?'
    : 'TRAVAR TODA a operação do robô (análises e ordens, real e simulação)?\n\nNenhuma ordem será enviada até você destravar.';
  if (!confirm(msg)) return;
  try {
    await setDoc(
      doc(db, 'global', 'controle'),
      { operacao_travada: !travado, travado_em: new Date().toISOString(), origem: 'dashboard' },
      { merge: true },
    );
  } catch (e) {
    alert(`Falha ao ${travado ? 'destravar' : 'travar'}: ${e.code ?? e.message}`);
  }
});

// ------------------------------------------------- kill-switch da IA (V8.10)
// Grava global/controle.ia_desligada — o MESMO doc da parada de emergência, que
// o bot já lê fresco a cada minuto (nenhuma leitura nova). Desligado, o ciclo do
// ativo roda inteiro MENOS a chamada à IA: o stop-loss e a trava de lucro são do
// Motor, não gastam quota e continuam protegendo as posições. Para congelar tudo
// o botão é o outro.
function renderControleIA() {
  const desligada = controle?.ia_desligada === true;
  const botao = $('botao-ia');
  if (botao) {
    botao.textContent = desligada ? '▶ Religar IA' : '🧠 Desligar IA';
    botao.className = desligada ? 'botao-primario' : 'botao-perigo';
  }
  const desc = $('ia-descricao');
  if (desc) {
    desc.textContent = desligada
      ? 'A IA está DESLIGADA: nenhuma análise nova e nenhuma ordem decidida por ela. O stop-loss e a '
        + 'trava de lucro continuam ativos, e a supervisão semanal está pausada.'
      : 'A chave da IA para de ser usada: nenhuma análise nova, nenhuma compra e nenhuma venda '
        + 'decidida por ela. O stop-loss e a trava de lucro continuam protegendo as posições.';
  }
  const banner = $('banner-ia');
  if (banner) {
    banner.hidden = !desligada;
    if (desligada) {
      // Mesma lógica do "travar tudo": o flag escrito não prova que o bot viu.
      const confirmado = statusBot?.ia_desligada === true;
      const desde = controle?.ia_desligada_em ? ` desde ${dataHora(controle.ia_desligada_em)}` : '';
      banner.textContent = `🧠 IA DESLIGADA${desde} — ${confirmado ? 'o bot confirmou' : 'aguardando o bot confirmar…'}`
        + ' · stop-loss e trava de lucro seguem ativos';
    }
  }
}

$('botao-ia').addEventListener('click', async () => {
  const desligada = controle?.ia_desligada === true;
  const msg = desligada
    ? 'Religar a IA e voltar a analisar normalmente?'
    : 'DESLIGAR a IA?\n\nO robô para de analisar e não abre nem fecha posição por decisão dela.\n\n'
      + 'O stop-loss e a trava de lucro continuam funcionando — as posições abertas seguem protegidas.';
  if (!confirm(msg)) return;
  try {
    await setDoc(
      doc(db, 'global', 'controle'),
      { ia_desligada: !desligada, ia_desligada_em: new Date().toISOString(), origem: 'dashboard' },
      { merge: true },
    );
  } catch (e) {
    alert(`Falha ao ${desligada ? 'religar' : 'desligar'} a IA: ${e.code ?? e.message}`);
  }
});

// ------------------------------------------- corte rápido dos avisos (V8.10)
// É o MESMO interruptor do card "Avisos no Telegram" (global/telegram.ativo),
// só que ao alcance da mão junto dos outros cortes. Nenhum toggle de evento é
// tocado: religar devolve exatamente a configuração de antes. Vale no próximo
// minuto: a config do Telegram é lida pelo catálogo cacheado, mas a dashboard
// avisa o bot pela marca em `global/controle` (V8.14), que derruba o catálogo
// na hora — e sem custar leitura nova no tick.
function renderControleAvisos() {
  const configurado = telegramSalvo?.token_configurado === true && Boolean(telegramSalvo?.chat_id);
  const desligados = !configurado || telegramSalvo?.ativo === false;
  const botao = $('botao-avisos');
  if (botao) {
    botao.disabled = !configurado;
    botao.textContent = desligados ? '🔔 Religar avisos' : '🔕 Desligar avisos';
    botao.className = desligados ? 'botao-primario' : 'botao-perigo';
  }
  const desc = $('avisos-descricao');
  if (desc) {
    desc.textContent = !configurado
      ? 'Configure o token e o chat id no card "Avisos no Telegram" abaixo para poder usar este botão.'
      : desligados
        ? 'Os avisos estão DESLIGADOS: o robô continua analisando e operando, mas não te manda nada. '
          + 'Suas escolhas de quais eventos avisar foram preservadas.'
        : 'O robô para de mandar mensagens no Telegram. Nada mais muda: ele continua analisando e '
          + 'operando normalmente. Vale no próximo minuto.';
  }
  const banner = $('banner-avisos');
  if (banner) {
    banner.hidden = !(configurado && desligados);
    if (configurado && desligados) {
      banner.textContent = '🔕 Avisos do Telegram desligados — o robô está operando em silêncio.';
    }
  }
}

$('botao-avisos').addEventListener('click', async () => {
  const desligados = telegramSalvo?.ativo === false;
  const msg = desligados
    ? 'Religar os avisos no Telegram?'
    : 'DESLIGAR os avisos no Telegram?\n\nO robô continua analisando e operando — você é que deixa de '
      + 'ser avisado, inclusive sobre problemas.\n\nVale no próximo minuto.';
  if (!confirm(msg)) return;
  try {
    await setDoc(
      doc(db, 'global', 'telegram'),
      { ativo: desligados, atualizado_em: new Date().toISOString() },
      { merge: true },
    );
    avisarConfigMudou();
  } catch (e) {
    alert(`Falha ao ${desligados ? 'religar' : 'desligar'} os avisos: ${e.code ?? e.message}`);
  }
});

// ------------------------------------------------------ modo vendas (V8)
// Liquidação da carteira: grava global/controle.modo_vendas. Ligado, o Motor
// bloqueia compras e passa a aceitar venda no prejuízo até a tolerância do DIA,
// que abre ao longo da janela. O dia e o percentual mostrados aqui vêm do
// HEARTBEAT (status_bot.modo_vendas), não de uma conta refeita no navegador:
// quem manda é o relógio do bot, e divergir na tela seria pior que não mostrar.
const MV_DIAS_PADRAO = 7;
const MV_PERDA_PADRAO = 15;

function renderModoVendas() {
  const ligado = controle?.modo_vendas === true;
  const vigente = statusBot?.modo_vendas?.ativo ? statusBot.modo_vendas : null;

  const botao = $('botao-modo-vendas');
  if (botao) {
    botao.textContent = ligado ? '▶ Desligar modo vendas' : '💰 Ligar modo vendas';
    botao.className = ligado ? 'botao-primario' : 'botao-perigo';
  }

  const banner = $('banner-modo-vendas');
  if (banner) {
    banner.hidden = !ligado;
    if (ligado) {
      banner.textContent = vigente
        ? `💰 MODO VENDAS — dia ${vigente.dia} de ${vigente.dias_totais} · prejuízo aceito hoje: ${vigente.perda_maxima_percentual}% por posição` +
          (vigente.dia > vigente.dias_totais ? ' · ⚠️ janela terminada, tolerância no teto' : '')
        : '💰 MODO VENDAS ligado — aguardando o bot confirmar…';
    }
  }

  const desc = $('mv-descricao');
  if (desc) {
    desc.textContent = ligado
      ? 'O robô está LIQUIDANDO: nenhuma compra é aceita, o supervisor semanal está pausado e o analista '
        + 'recebe o prompt de liquidação. Ele não desliga sozinho — desligue aqui quando terminar.'
      : 'Encerra a carteira: o robô para de comprar e passa a procurar a melhor saída para as posições '
        + 'abertas. A tolerância a prejuízo começa em 0% e abre ao longo da janela.';
  }

  if (document.activeElement !== $('mv-dias')) $('mv-dias').value = controle?.modo_vendas_dias ?? MV_DIAS_PADRAO;
  if (document.activeElement !== $('mv-perda')) {
    $('mv-perda').value = controle?.modo_vendas_perda_maxima_percentual ?? MV_PERDA_PADRAO;
  }
}

$('botao-modo-vendas').addEventListener('click', async () => {
  const ligado = controle?.modo_vendas === true;
  const dias = Number($('mv-dias').value) || MV_DIAS_PADRAO;
  const perda = Number($('mv-perda').value);
  const teto = Number.isFinite(perda) ? perda : MV_PERDA_PADRAO;
  const msg = ligado
    ? 'Desligar o modo vendas e voltar à operação normal?\n\nAs compras voltam a ser permitidas e o supervisor semanal volta a rodar.'
    : `LIGAR O MODO VENDAS?\n\nO robô vai parar de comprar e passar a liquidar as posições ao longo de ${dias} dias.\n\n`
      + `A partir do 2º dia ele poderá VENDER NO PREJUÍZO, até ${teto}% por posição no fim da janela.\n\n`
      + 'O modo não desliga sozinho: você precisa desligá-lo aqui.';
  if (!confirm(msg)) return;
  try {
    await setDoc(
      doc(db, 'global', 'controle'),
      ligado
        // Desligar preserva `modo_vendas_desde`: se o dono religar por engano, a
        // data antiga faria a rampa reabrir no meio. Zerar aqui garante que toda
        // liquidação nova comece no dia 1, com tolerância zero.
        ? { modo_vendas: false, modo_vendas_desde: null, modo_vendas_desligado_em: new Date().toISOString(), origem: 'dashboard' }
        : {
            modo_vendas: true,
            modo_vendas_desde: new Date().toISOString(),
            modo_vendas_dias: dias,
            modo_vendas_perda_maxima_percentual: teto,
            origem: 'dashboard',
          },
      { merge: true },
    );
  } catch (e) {
    alert(`Falha ao ${ligado ? 'desligar' : 'ligar'} o modo vendas: ${e.code ?? e.message}`);
  }
});

$('form-modo-vendas').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = $('mv-status');
  const dias = Number($('mv-dias').value);
  const perda = Number($('mv-perda').value);
  if (!Number.isFinite(dias) || dias < 1 || !Number.isFinite(perda) || perda < 0) {
    status.textContent = 'valores inválidos';
    return;
  }
  status.textContent = 'salvando…';
  try {
    await setDoc(
      doc(db, 'global', 'controle'),
      { modo_vendas_dias: Math.floor(dias), modo_vendas_perda_maxima_percentual: perda, origem: 'dashboard' },
      { merge: true },
    );
    status.textContent = 'salvo ✓ (vale no próximo ciclo)';
  } catch (e) {
    status.textContent = `erro: ${e.code ?? e.message}`;
  }
});

// -------------------------------------------------------------- visão geral
function renderGeral() {
  renderStatusBot();
  renderControle();
  renderControleIA();
  renderControleAvisos();
  renderModoVendas();
  const corpo = $('tabela-geral-ativos').tBodies[0];
  corpo.textContent = '';
  for (const [pid, p] of plataformas) {
    // A Steam fica FORA desta tabela e do patrimônio: ela tem tela própria, e o
    // dinheiro dela é carteira de jogo — não dá para sacar, então misturá-lo ao
    // patrimônio (ainda que numa linha só dela) daria a impressão de dinheiro
    // disponível. Um inventário de dezenas de skins também afogaria os ativos
    // financeiros, que é o que esta tela existe para mostrar.
    if (pid === PLATAFORMA_STEAM) continue;

    const moedaP = p.dados?.moeda ?? 'BRL';
    const ordenados = [...p.ativos.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (ordenados.length === 0) continue;

    // Cabeçalho do grupo: separa os ativos por plataforma para dar visibilidade.
    const linhaGrupo = corpo.insertRow();
    linhaGrupo.className = 'linha-grupo-plataforma';
    const celGrupo = linhaGrupo.insertCell();
    celGrupo.colSpan = 9;
    celGrupo.textContent = `${p.dados?.nome || pid} · ${moedaP}`;

    for (const [aid, ativo] of ordenados) {
      const leve = p.porAtivo.get(aid);
      const modo = modoDoAtivo(ativo);
      const carteira = leve?.dashboard?.carteira_atual ?? null;
      const stats = leve?.estatisticas?.[modo] ?? null;
      const decisao = leve?.estado?.ultima_decisao_ia ?? null;
      const ligado = ativo.config?.ativo !== false;

      // O total lá de cima é somado por `consolidarPatrimonio` (patrimonio.js),
      // que só conta carteira REAL. Aqui a tabela mostra TODOS os ativos, com o
      // selo do modo de cada um — é o lugar certo para a simulação aparecer.
      const naoRealizado = carteira?.lucro_nao_realizado ?? null;

      const linha = corpo.insertRow();
      // Ativo desligado é contexto, não notícia: fica esmaecido para o olho
      // cair primeiro no que está operando.
      if (!ligado) linha.className = 'linha-desligada';
      const celAtivo = linha.insertCell();
      const linkAtivo = document.createElement('a');
      linkAtivo.href = `#/ativo/${pid}/${aid}`;
      linkAtivo.textContent = `${ativo.manifest?.nome || aid} (${aid})`;
      celAtivo.append(linkAtivo);

      // Estado e modo viram marcadores: varrer a coluna fica mais rápido que
      // ler "ligado/desligado" linha por linha. A forma/cor acompanha o texto,
      // nunca o substitui.
      const celEstado = linha.insertCell();
      const ponto = document.createElement('span');
      ponto.className = `ponto-estado ${ligado ? 'ligado' : 'desligado'}`;
      celEstado.append(ponto, document.createTextNode(ligado ? 'ligado' : 'desligado'));

      const celModo = linha.insertCell();
      const badgeModo = document.createElement('span');
      badgeModo.className = `badge ${modo === 'real' ? 'real' : 'simulacao'}`;
      badgeModo.textContent = modo === 'real' ? 'REAL' : 'simulação';
      celModo.append(badgeModo);
      linha.insertCell().textContent = dinheiro(carteira?.preco_atual ?? null, moedaP);
      linha.insertCell().textContent = qtd(carteira?.saldo_ativo ?? null);
      const valorPosicao =
        carteira?.saldo_ativo != null && carteira?.preco_atual != null
          ? carteira.saldo_ativo * carteira.preco_atual
          : null;
      linha.insertCell().textContent = dinheiro(valorPosicao, moedaP);
      const celNaoRealizado = linha.insertCell();
      celNaoRealizado.textContent = dinheiro(naoRealizado, moedaP);
      if (naoRealizado) celNaoRealizado.className = naoRealizado > 0 ? 'valor-positivo' : 'valor-negativo';
      const celLucro = linha.insertCell();
      celLucro.textContent = dinheiro(stats?.lucro_total ?? null, moedaP);
      if (stats?.lucro_total) celLucro.className = stats.lucro_total > 0 ? 'valor-positivo' : 'valor-negativo';
      linha.insertCell().textContent = decisao ? `${decisao.acao} ${dataHora(decisao.horario)}` : '—';
    }
  }

  // Hero: UM total consolidado em BRL (V6.2). Moedas estrangeiras são
  // convertidas pelo câmbio do BCB (doc global/cambio, só exibição). Sem
  // cotação para alguma moeda com saldo, ela fica de fora e avisamos.
  const { patrimonioBRL, caixaBRL, naoRealizadoBRL, temDados, semCambio } = consolidarPatrimonio({
    plataformas,
    cambio,
    excluir: [PLATAFORMA_STEAM],
  });
  $('geral-patrimonio').textContent = temDados ? dinheiro(patrimonioBRL, 'BRL') : '—';
  const partesCaixa = [];
  if (temDados) partesCaixa.push(`caixa disponível: ${dinheiro(caixaBRL, 'BRL')}`);
  if (cambio?.USD?.para_brl) partesCaixa.push(`US$ a ${dinheiro(cambio.USD.para_brl, 'BRL')}`);
  if (semCambio.size > 0) partesCaixa.push(`⚠️ ${[...semCambio].join(', ')} fora do total (sem câmbio)`);
  $('geral-caixa').textContent = partesCaixa.join(' · ');

  // Se vender tudo agora: lucro/prejuízo não realizado consolidado em BRL.
  const tileNaoReal = $('geral-nao-realizado');
  tileNaoReal.textContent = temDados ? dinheiro(naoRealizadoBRL, 'BRL') : '—';
  tileNaoReal.className = 'tile-valor';
  if (temDados && naoRealizadoBRL) {
    tileNaoReal.classList.add(naoRealizadoBRL > 0 ? 'valor-positivo' : 'valor-negativo');
  }
  // A borda do cartão inteiro carrega o sinal — o olho pega antes de ler.
  const cartaoNaoReal = $('tile-nao-realizado');
  if (cartaoNaoReal) {
    cartaoNaoReal.className = 'cartao tile tile-sinal';
    if (temDados && naoRealizadoBRL) {
      cartaoNaoReal.classList.add(naoRealizadoBRL > 0 ? 'positivo' : 'negativo');
    }
  }
  $('geral-nao-realizado-nota').textContent = temDados
    ? naoRealizadoBRL >= 0
      ? 'lucro líquido se liquidar todas as posições'
      : 'prejuízo líquido se liquidar todas as posições'
    : '';
  renderRendaReal();
}

// ----------------------------------------- renda real × 106% do CDI (Selic)
// Tudo já vem calculado pelo bot (doc global/renda_real): aqui é só exibição.
const FONTES_SELIC = {
  api_bcb: 'API do Banco Central',
  anterior: 'última taxa conhecida — API do BCB indisponível',
  padrao: 'valor padrão do robô — API do BCB nunca respondeu',
  manual: 'valor definido manualmente por você',
};

// Preenche os inputs de Selic/% do CDI com os valores em vigor, sem atropelar
// o que o dono está digitando (só escreve no campo que não está em foco).
function preencherConfigRenda() {
  const selic = rendaReal?.selic ?? {};
  const inSelic = $('input-selic');
  const inCdi = $('input-percentual-cdi');
  const selicAtual = Number.isFinite(configRenda?.selic_manual)
    ? configRenda.selic_manual
    : selic.taxa_aa;
  const cdiAtual = configRenda?.percentual_cdi ?? selic.percentual_cdi ?? 106;
  if (inSelic && document.activeElement !== inSelic && selicAtual != null) inSelic.value = selicAtual;
  if (inCdi && document.activeElement !== inCdi && cdiAtual != null) inCdi.value = cdiAtual;
}

function renderRendaReal() {
  const intro = $('renda-cdi-intro');
  const wrap = $('renda-cdi-tabela-wrap');
  const rodape = $('renda-cdi-rodape');
  const ehSim = rendaModo === 'simulacao';

  // Percentual do CDI em vigor (manual ou padrão): rotula título/coluna/rodapé.
  const percentualCDI = rendaReal?.selic?.percentual_cdi ?? configRenda?.percentual_cdi ?? 106;
  $('renda-cdi-titulo').textContent = `Rendimento × ${pctCdi(percentualCDI)} do CDI`;
  $('renda-cdi-col-bench').textContent = `${pctCdi(percentualCDI)} do CDI`;
  preencherConfigRenda();

  // Aba ativa nos botões + rótulo da coluna do robô.
  for (const b of $('renda-cdi-modos').querySelectorAll('button')) {
    b.classList.toggle('ativo', b.dataset.modo === rendaModo);
  }
  $('renda-cdi-col-bot').textContent = ehSim ? 'Robô (simulação)' : 'Robô (modo real)';

  // Bloco selecionado: real vive no TOPO do doc; simulação em `.simulacao`.
  const bloco = ehSim
    ? rendaReal?.simulacao
      ? { ...rendaReal.simulacao, lucro_real_por_moeda: rendaReal.simulacao.lucro_por_moeda }
      : null
    : rendaReal?.inicio_comparacao
      ? rendaReal
      : null;

  if (!bloco?.inicio_comparacao) {
    intro.textContent = ehSim
      ? 'O comparativo da simulação aparece quando houver ao menos um ativo em modo simulação com histórico.'
      : 'O comparativo aparece quando o primeiro ativo entrar em modo REAL — só o lucro realizado fora da simulação entra na conta.';
    wrap.hidden = true;
    rodape.textContent = '';
    return;
  }

  const moeda = bloco.moeda_comparacao ?? 'BRL';
  const comp = bloco.comparativo ?? {};
  const bot = comp.bot ?? {};
  const bench = comp.benchmark ?? {};

  // Moeda SEM cotação não entra nesta linha. Ela já fica de fora do total (o
  // bot não chuta câmbio) e a carteira Steam é o caso real disso: exibi-la ao
  // lado de R$ e US$ num card que compara com o CDI sugeriria dinheiro
  // aplicável, e ela nem sacar dá. A régua é o próprio aviso do bot — nada de
  // `if` por nome de plataforma aqui.
  const semCambio = new Set(bloco.moedas_sem_cambio ?? []);
  const lucros = Object.entries(bloco.lucro_real_por_moeda ?? {})
    .filter(([m, v]) => v != null && !semCambio.has(m))
    .map(([m, v]) => dinheiro(v, m));
  intro.textContent = `${ehSim ? 'Lucro simulado (só ativos em simulação)' : 'Lucro realizado (só ativos em modo real)'}: ${lucros.length > 0 ? lucros.join(' · ') : dinheiro(0, moeda)}`;

  const corpo = $('tabela-renda-cdi').tBodies[0];
  corpo.textContent = '';
  const linha = (rotulo, valorBot, valorBench, formatar = pct) => {
    const tr = corpo.insertRow();
    tr.insertCell().textContent = rotulo;
    const celBot = tr.insertCell();
    celBot.textContent = formatar(valorBot);
    if (valorBot != null && valorBench != null) {
      celBot.className = valorBot >= valorBench ? 'valor-positivo' : 'valor-negativo';
    }
    tr.insertCell().textContent = formatar(valorBench);
  };
  linha('% ao ano (a.a.)', bot.ano ?? null, bench.ano ?? null);
  linha('% ao mês (a.m.)', bot.mes ?? null, bench.mes ?? null);
  linha('% na semana', bot.semana ?? null, bench.semana ?? null);
  linha('% no período', bot.periodo ?? null, bench.periodo ?? null);
  linha('No período (dinheiro)', comp.lucro_bot ?? null, comp.rendimento_benchmark ?? null, (v) => dinheiro(v, moeda));
  wrap.hidden = false;

  const selic = rendaReal.selic ?? {}; // Selic é compartilhada pelos dois modos
  const partes = [
    `Desde ${dataHora(bloco.inicio_comparacao)} (${bloco.dias_comparacao ?? 0} dias · ${bloco.dias_uteis_comparacao ?? 0} úteis p/ o CDI)`,
    `Selic ${pct(selic.taxa_aa)} a.a. (${FONTES_SELIC[selic.fonte] ?? selic.fonte ?? '—'})`,
    `CDI ≈ ${pct(selic.cdi_aa)} → ${pctCdi(selic.percentual_cdi ?? 106)} do CDI = ${pct(selic.benchmark_aa)} a.a.`,
    bloco.patrimonio_inicial != null
      ? `principal considerado: ${dinheiro(bloco.patrimonio_inicial, moeda)}${detalhePrincipal(bloco)}`
      : `os % do robô aparecem após a primeira análise em modo ${ehSim ? 'simulação' : 'real'} (principal ainda desconhecido)`,
  ];
  rodape.textContent = `${partes.join(' · ')} · atualizado em ${dataHora(rendaReal.atualizado_em)}`;
}

// De onde saiu o principal: quais carteiras entraram na soma e quando foram
// medidas. É a resposta, na tela, para "esse % está dividindo por qual dinheiro?"
// — o principal é só o patrimônio dos ativos DAQUELE modo, nunca o do outro.
// `fora` são plataformas do modo que não entraram (sem referência ainda, medida
// sob a regra antiga, ou moeda sem cotação): o principal é parcial e diz isso.
function detalhePrincipal(bloco) {
  const dentro = bloco.patrimonio_inicial_plataformas ?? [];
  const fora = bloco.patrimonio_inicial_fora ?? [];
  const partes = [];
  if (dentro.length > 0) partes.push(dentro.join(' + '));
  if (bloco.patrimonio_inicial_medido_em) partes.push(`medido em ${dataDia(bloco.patrimonio_inicial_medido_em)}`);
  if (fora.length > 0) partes.push(`fora: ${fora.join(', ')}`);
  return partes.length > 0 ? ` (${partes.join(' · ')})` : '';
}

// Alterna a aba Real/Simulação do comparativo × CDI (V6.2).
$('renda-cdi-modos').addEventListener('click', (ev) => {
  const modo = ev.target?.dataset?.modo;
  if (modo && modo !== rendaModo) {
    rendaModo = modo;
    renderRendaReal();
  }
});

// Salvar ajustes manuais do comparativo × CDI (V6.5): grava global/config_renda.
// Selic em branco → volta a usar a API do BCB; % do CDI é obrigatório (padrão 106).
$('form-config-renda').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('config-renda-msg');
  const parseNum = (s) => {
    const t = String(s ?? '').trim().replace(',', '.');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  const selic = parseNum($('input-selic').value);
  const cdi = parseNum($('input-percentual-cdi').value);
  if (Number.isNaN(selic) || (selic !== null && selic <= 0)) {
    msg.textContent = 'Selic inválida — informe um número maior que zero (ou deixe em branco para usar a API do BCB).';
    return;
  }
  if (Number.isNaN(cdi) || cdi === null || cdi <= 0) {
    msg.textContent = '% do CDI inválido — informe um número maior que zero (ex.: 106).';
    return;
  }
  try {
    await setDoc(
      doc(db, 'global', 'config_renda'),
      { selic_manual: selic, percentual_cdi: cdi, atualizado_em: new Date().toISOString(), origem: 'dashboard' },
      { merge: true },
    );
    const selicTxt = selic === null ? 'Selic pela API do BCB' : `Selic ${pct(selic)}`;
    msg.textContent = `Salvo: ${selicTxt} · ${pctCdi(cdi)} do CDI. O bot aplica no próximo recálculo (até ~1 h).`;
  } catch (e) {
    msg.textContent = `Falha ao salvar: ${e.code ?? e.message}`;
  }
});

// ------------------------------------------------------- avisos no Telegram
// O doc `global/telegram` guarda token, chat id e os toggles de evento. O token
// NUNCA volta para a tela: o campo fica vazio e, em branco no submit, mantém o
// que já está gravado (mesma regra das chaves de corretora).

let telegramSalvo = null;

/**
 * Resultado do último envio, que o bot publica no heartbeat. Sem isto um chat
 * id errado só apareceria no log do pm2 — foi o que aconteceu na primeira
 * configuração real (o id do próprio bot foi colado no lugar do id do dono).
 */
function renderTelegramStatus() {
  const el = $('telegram-status');
  if (!el) return;
  const envio = statusBot?.telegram;
  if (!envio) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `telegram-status ${envio.ok ? 'ok' : 'erro'}`;
  const quando = envio.em ? new Date(envio.em).toLocaleString('pt-BR') : '';
  el.textContent = envio.ok
    ? `✅ Último envio funcionou (${quando}).`
    : `❌ Último envio falhou (${quando}): ${envio.erro ?? 'erro desconhecido'}`;
}

function renderTelegram(dados) {
  telegramSalvo = dados ?? null;
  renderTelegramStatus();
  // O botão "desligar avisos" dos controles rápidos é o MESMO interruptor deste
  // card — os dois têm de contar a mesma história a cada snapshot.
  renderControleAvisos();
  // Resumo no cabeçalho recolhido: com o painel fechado, ainda dá para saber
  // se os avisos estão ligados sem abrir nada.
  const resumo = $('telegram-resumo');
  if (resumo) {
    const ligado = dados?.ativo !== false && dados?.token_configurado === true;
    resumo.textContent = ligado ? 'ligado' : dados?.token_configurado ? 'desligado' : 'não configurado';
    resumo.className = `config-resumo${ligado ? ' ligado' : ''}`;
  }
  const temToken = dados?.token_configurado === true;
  $('tg-ativo').checked = dados?.ativo !== false && temToken;
  $('tg-chat').value = dados?.chat_id ?? '';
  $('tg-token').placeholder = temToken
    ? 'token salvo — deixe em branco para manter'
    : 'cole aqui o token do @BotFather';
  for (const ev of ['compra', 'venda', 'recomendacao', 'problema', 'relatorio', 'supervisao', 'noticia_jogo', 'alerta_preco']) {
    $(`tg-ev-${ev}`).checked = dados?.eventos?.[ev] !== false;
  }
}

$('form-telegram').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('telegram-msg');
  const token = $('tg-token').value.trim();
  const chat = $('tg-chat').value.trim();
  const ligado = $('tg-ativo').checked;

  if (ligado && !token && telegramSalvo?.token_configurado !== true) {
    msg.textContent = 'Informe o token do bot antes de ligar os avisos.';
    return;
  }
  if (ligado && !chat) {
    msg.textContent = 'Informe o chat id — sem ele o robô não sabe para quem mandar.';
    return;
  }

  const dados = {
    ativo: ligado,
    chat_id: chat,
    // O token não mora mais aqui (foi para o doc protegido), então a tela
    // precisa deste sinalizador NÃO secreto para saber que existe um gravado.
    token_configurado: Boolean(token) || telegramSalvo?.token_configurado === true,
    eventos: {
      compra: $('tg-ev-compra').checked,
      venda: $('tg-ev-venda').checked,
      recomendacao: $('tg-ev-recomendacao').checked,
      problema: $('tg-ev-problema').checked,
      relatorio: $('tg-ev-relatorio').checked,
      supervisao: $('tg-ev-supervisao').checked,
      noticia_jogo: $('tg-ev-noticia_jogo').checked,
      alerta_preco: $('tg-ev-alerta_preco').checked,
    },
    atualizado_em: new Date().toISOString(),
  };
  try {
    // O TOKEN vai para um doc separado que as rules tornam ilegível pelo
    // navegador; `global/telegram` fica só com o que não é segredo. Campo em
    // branco não escreve nada — preserva o token já gravado.
    if (token) await setDoc(doc(db, 'global', 'telegram_token'), { bot_token: token }, { merge: true });
    await setDoc(doc(db, 'global', 'telegram'), dados, { merge: true });
    avisarConfigMudou();
    $('tg-token').value = '';
    msg.textContent = ligado
      ? 'Salvo. Em até um minuto você deve receber uma mensagem de confirmação no Telegram.'
      : 'Salvo. Avisos desligados.';
  } catch (e) {
    msg.textContent = `Falha ao salvar: ${e.code ?? e.message}`;
  }
});

// --------------------------------------------------------------------- tiles
function renderTiles() {
  const ativo = ativoSelecionado();
  const leve = leveSelecionado();
  if (!ativo || !leve) return;
  const modo = modoDoAtivo(ativo);
  const stats = leve.estatisticas?.[modo] ?? null;
  const carteira = leve.dashboard?.carteira_atual ?? null;

  const valorPosicao =
    carteira?.saldo_ativo != null && carteira?.preco_atual != null
      ? carteira.saldo_ativo * carteira.preco_atual
      : null;
  $('tile-valor-posicao').textContent = dinheiro(valorPosicao);

  const lucroTotal = stats?.lucro_total ?? null;
  const delta = $('tile-lucro-delta');
  delta.className = 'tile-delta';
  const rotuloModo = modo === 'real' ? 'real' : 'simulação';
  if (lucroTotal !== null && lucroTotal !== 0) {
    delta.classList.add(lucroTotal > 0 ? 'sobe' : 'desce');
    delta.textContent = `${lucroTotal > 0 ? '▲' : '▼'} ${dinheiro(Math.abs(lucroTotal))} realizados desde o início (${rotuloModo})`;
  } else {
    delta.textContent = `sem lucro realizado ainda (${rotuloModo})`;
  }

  $('tile-saldo-moeda').textContent = dinheiro(carteira?.saldo_moeda ?? null);
  $('tile-saldo-ativo').textContent = qtd(carteira?.saldo_ativo ?? null);
  $('tile-preco').textContent = dinheiro(carteira?.preco_atual ?? leve.estado?.preco_ultima_analise ?? null);
  $('tile-preco-medio').textContent = dinheiro(carteira?.preco_medio_compra ?? null);
  $('tile-lucro').textContent = dinheiro(lucroTotal);
  $('tile-operacoes').textContent = stats?.quantidade_operacoes ?? '—';
  $('tile-acerto').textContent = stats?.taxa_acerto != null ? pct(stats.taxa_acerto) : '—';
  $('tile-maior-lucro').textContent = dinheiro(stats?.maior_lucro_operacao ?? null);
  $('tile-maior-prejuizo').textContent = dinheiro(stats?.maior_prejuizo_operacao ?? null);

  // Dividendos recebidos (informativo, V6.3) — só para ativos que pagam dividendo.
  const pagaDividendo = ativoSelecionado()?.manifest?.permiteDividendos === true;
  $('tile-cartao-dividendos').hidden = !pagaDividendo;
  $('tile-dividendos').textContent = dinheiro(stats?.dividendos_recebidos ?? 0);
}

// ------------------------------------------------------------------- decisão
function renderDecisao() {
  const d = leveSelecionado()?.estado?.ultima_decisao_ia;
  const chip = $('chip-decisao');
  if (!d) {
    chip.textContent = '—';
    chip.className = 'chip';
    $('decisao-confianca').textContent = '';
    $('decisao-justificativa').textContent = 'Aguardando primeira análise…';
    $('decisao-horario').textContent = '';
    return;
  }
  const rotulos = { COMPRAR: '↑ COMPRAR', VENDER: '↓ VENDER', AGUARDAR: '– AGUARDAR' };
  chip.textContent = rotulos[d.acao] ?? d.acao;
  chip.className = `chip ${d.acao === 'COMPRAR' ? 'comprar' : d.acao === 'VENDER' ? 'vender' : ''}`;
  const partes = [];
  if (d.confianca != null) partes.push(`confiança ${d.confianca}%`);
  if (d.percentual) partes.push(`${d.percentual}% da base`);
  if (d.modelo) partes.push(d.modelo);
  $('decisao-confianca').textContent = partes.join(' · ');
  $('decisao-justificativa').textContent = d.justificativa ?? '';
  $('decisao-horario').textContent = d.horario ? `em ${dataHora(d.horario)}` : '';
}

// ------------------------------------- modo assistido (recomendação + registro)
function renderAssistido() {
  if (rota.tipo !== 'ativo') return;
  const assistida = plataformaAssistida(rota.plataforma);
  $('cartao-operacao-manual').hidden = !assistida;
  if (assistida) ajustarCamposOpManual(); // campos coerentes com o tipo atual

  const rec = assistida ? leveSelecionado()?.dashboard?.recomendacao ?? null : null;
  $('cartao-recomendacao').hidden = !rec;
  if (!rec) return;
  const verbo = rec.tipo === 'COMPRA' ? 'COMPRAR' : rec.tipo === 'VENDA' ? 'VENDER' : rec.tipo;
  const partes = [];
  if (rec.quantidade != null) partes.push(`${qtd(rec.quantidade)} unidades`);
  if (rec.valor != null) partes.push(`≈ ${dinheiro(rec.valor)}`);
  if (rec.preco != null) partes.push(`ao preço de referência ${dinheiro(rec.preco)}`);
  // ALERTA DE OPORTUNIDADE (V8.22, §10.12): a compra vem SEM tamanho — o robô
  // não sabe quanto há em caixa na corretora. O que ele sugere é a FATIA.
  if (rec.quantidade == null && rec.valor == null && rec.percentual_sugerido != null) {
    partes.push(`fatia sugerida ${rec.percentual_sugerido}% do que você quiser alocar`);
  }
  $('recomendacao-acao').textContent = `${verbo === 'COMPRAR' ? '↑' : '↓'} ${verbo} ${rota.ativo}`;
  $('recomendacao-detalhe').textContent =
    `${partes.join(' · ')}${rec.justificativa ? ` — ${rec.justificativa}` : ''}`;
  $('recomendacao-horario').textContent = rec.horario ? `sugerida em ${dataHora(rec.horario)}` : '';
}

// DIVIDENDO usa só "valor por ação" (a quantidade sai da carteira); COMPRA/
// VENDA usam quantidade + preço + taxa. Alterna os campos conforme o tipo —
// campos desabilitados saem da validação `required` do formulário.
function ajustarCamposOpManual() {
  const ehDividendo = $('opman-tipo').value === 'DIVIDENDO';
  const alternar = (campoId, inputId, mostrar, obrigatorio) => {
    $(campoId).hidden = !mostrar;
    const inp = $(inputId);
    inp.disabled = !mostrar;
    inp.required = mostrar && obrigatorio;
  };
  alternar('opman-campo-quantidade', 'opman-quantidade', !ehDividendo, true);
  alternar('opman-campo-preco', 'opman-preco', !ehDividendo, true);
  alternar('opman-campo-taxa', 'opman-taxa', !ehDividendo, false);
  alternar('opman-campo-valor-acao', 'opman-valor-acao', ehDividendo, true);
}
$('opman-tipo').addEventListener('change', ajustarCamposOpManual);

$('form-op-manual').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'ativo') return;
  const status = $('opman-status');
  const tipo = $('opman-tipo').value;
  const dataCampo = $('opman-data').value; // datetime-local (fuso do navegador)
  const id = `opman_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    id,
    tipo,
    data: dataCampo ? new Date(dataCampo).toISOString() : new Date().toISOString(),
    processada: false,
    criada_em: new Date().toISOString(),
  };

  let pedido;
  if (tipo === 'DIVIDENDO') {
    const valorPorAcao = Number($('opman-valor-acao').value);
    if (!(valorPorAcao > 0)) {
      status.textContent = 'informe o valor do dividendo por ação maior que zero';
      return;
    }
    pedido = { ...base, valor_por_acao: valorPorAcao };
  } else {
    const quantidade = Number($('opman-quantidade').value);
    const preco = Number($('opman-preco').value);
    if (!(quantidade > 0) || !(preco > 0)) {
      status.textContent = 'informe quantidade e preço maiores que zero';
      return;
    }
    const taxaCampo = $('opman-taxa').value;
    pedido = { ...base, quantidade, preco, taxa: taxaCampo === '' ? null : Number(taxaCampo) };
  }

  status.textContent = 'registrando…';
  try {
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'ativos', rota.ativo, 'operacoes_manuais', id), pedido);
    $('opman-quantidade').value = '';
    $('opman-preco').value = '';
    $('opman-valor-acao').value = '';
    $('opman-taxa').value = '';
    status.textContent = tipo === 'DIVIDENDO'
      ? 'dividendo registrado ✓ — o robô soma no total do ativo no próximo ciclo'
      : 'registrada ✓ — o robô aplica no próximo ciclo do ativo';
  } catch (e) {
    status.textContent = `erro ao registrar: ${e.code ?? e.message}`;
  }
});

// -------------------------------------------------------------------- ciclo
function renderCiclo() {
  const estado = leveSelecionado()?.estado ?? null;
  $('info-ultima-analise').textContent = dataHora(estado?.horario_ultima_analise);
  $('info-ultima-verificacao').textContent = dataHora(estado?.horario_ultima_verificacao);
}
setInterval(() => {
  const alvo = leveSelecionado()?.estado?.proxima_analise_em;
  const el = $('info-contagem');
  if (!el || rota.tipo !== 'ativo') return;
  if (!alvo) { el.textContent = '—'; return; }
  const resta = new Date(alvo).getTime() - Date.now();
  if (resta <= 0) { el.textContent = 'a qualquer momento'; return; }
  const s = Math.floor(resta / 1000);
  const p = (n) => String(n).padStart(2, '0');
  el.textContent = s >= 3600 ? `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}, 1000);

// ------------------------------------------------------------------ gráficos
function renderGraficos() {
  if (rota.tipo !== 'ativo') return;
  const ativo = ativoSelecionado();
  const historico = telaDados.historico ?? [];
  // Só a série do modo ativo: patrimônio/lucro de simulação e real são
  // grandezas diferentes. Entradas antigas sem `modo` são da fase simulação.
  const modo = modoDoAtivo(ativo);
  const doModo = historico.filter((h) => h.tipo === 'analise' && (h.modo ?? 'simulacao') === modo);
  // O PATRIMÔNIO não é do ativo, é da plataforma: desde a V8.16 ele é desenhado
  // na tela da plataforma, juntando o histórico de todos os ativos dela.
  const pontosLucro = doModo
    .map((h) => ({ x: new Date(h.horario), y: h.lucro_total }))
    .filter((p) => Number.isFinite(p.y));

  // Preço do ativo: TODA entrada do histórico (verificação e análise) tem
  // preco_atual, e o preço independe do modo — a série usa tudo. As operações
  // EXECUTADAS do modo ativo viram marcadores sobre a linha: ▲ compra (amarelo),
  // ▼ venda decidida pela IA (azul) e ▼ venda por STOP-LOSS do Motor (vermelho).
  // A venda por stop é a única que pode sair no prejuízo — separá-la na cor
  // deixa visível, de relance, quantas saídas foram defesa e não realização.
  const pontosPreco = historico
    .map((h) => ({ x: new Date(h.horario), y: h.preco_atual }))
    .filter((p) => Number.isFinite(p.y));
  const marcadores = (telaDados.operacoes ?? [])
    .filter((op) => op.status === 'executada'
      && (op.modo ?? 'simulacao') === modo
      && (op.tipo === 'COMPRA' || op.tipo === 'VENDA')
      && Number.isFinite(op.preco))
    .map((op) => ({
      x: new Date(op.horario),
      y: op.preco,
      tipo: op.tipo === 'VENDA' && op.origem_decisao === 'motor_stop_loss'
        ? 'VENDA_STOP'
        : op.tipo === 'VENDA' && op.origem_decisao === 'ia_modo_vendas'
          ? 'VENDA_LIQ'
          : op.tipo === 'VENDA' && op.origem_decisao === 'motor_trava_lucro'
            ? 'VENDA_TRAVA'
            : op.tipo,
    }));

  desenharLinha($('grafico-preco'), pontosPreco, 'var(--serie-preco)', marcadores);
  desenharLinha($('grafico-lucro'), pontosLucro, 'var(--serie-lucro)');
  preencherTabelaDados($('tabela-preco'), pontosPreco);
  preencherTabelaDados($('tabela-lucro'), pontosLucro);
}

/** Escala "bonita": ~4 divisões em números redondos. */
function escalaBonita(min, max, divisoes = 4) {
  if (min === max) { min -= Math.abs(min) * 0.01 || 1; max += Math.abs(max) * 0.01 || 1; }
  const bruto = (max - min) / divisoes;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto);
  const inicio = Math.floor(min / passo) * passo;
  const ticks = [];
  // O último tick precisa COBRIR o máximo (senão os picos saem do gráfico).
  for (let v = inicio; ; v += passo) {
    ticks.push(Number(v.toFixed(10)));
    if (v >= max - passo * 0.001) break;
  }
  return ticks;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(nome, attrs = {}) {
  const n = document.createElementNS(SVG_NS, nome);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Cores dos marcadores de operação (a FORMA acompanha: ▲ compra, ▼ venda —
// a cor nunca carrega a identidade sozinha; legenda e tooltip dizem o tipo).
// As duas vendas compartilham o ▼ (ambas são saídas); o que as separa é a cor
// E o rótulo do tooltip, nunca a cor sozinha.
const MARCA_OPERACAO = {
  COMPRA: { cor: 'var(--marca-compra)', rotulo: 'compra' },
  VENDA: { cor: 'var(--marca-venda)', rotulo: 'venda (IA)' },
  VENDA_STOP: { cor: 'var(--marca-venda-stop)', rotulo: 'venda por stop-loss (Motor)' },
  // Liquidação (V8): a outra saída que pode sair no vermelho. Cor própria
  // porque misturá-la com a venda normal esconderia o prejuízo aceito.
  VENDA_LIQ: { cor: 'var(--marca-venda-liquidacao)', rotulo: 'venda na liquidação (modo vendas)' },
  // Trava de lucro (V8.11): a saída que REALIZA — o oposto do stop, e por isso
  // cor própria. Sem separá-la, "o Motor vendeu" viraria uma coisa só no
  // gráfico e ninguém saberia se o robô se protegeu ou se ganhou dinheiro.
  VENDA_TRAVA: { cor: 'var(--marca-venda-trava)', rotulo: 'venda pela trava de lucro (Motor)' },
};

// Quantas vezes a cadência NORMAL do ativo um buraco precisa ter para valer
// uma quebra na linha. Relativo, nunca absoluto: cripto roda 24h a cada 15 min
// e quebra na parada de horas; ação em diário só quebraria num buraco de dias.
// O núcleo do bot é agnóstico de ativo (CLAUDE.md §1.1) — o gráfico também.
const FATOR_LACUNA = 6;

/**
 * Divide a série nos trechos separados por lacunas (pregão fechado, fim de
 * semana, bot parado). O limiar sai da MEDIANA dos intervalos da própria série,
 * então cada ativo calibra o seu sem nenhuma configuração.
 */
function segmentarPorLacuna(pontos) {
  if (pontos.length < 3) return [pontos];
  const difs = [];
  for (let i = 1; i < pontos.length; i++) difs.push(pontos[i].x - pontos[i - 1].x);
  const ordenados = [...difs].sort((a, b) => a - b);
  const mediana = ordenados[Math.floor(ordenados.length / 2)];
  if (!(mediana > 0)) return [pontos];
  const limiar = mediana * FATOR_LACUNA;

  const trechos = [[pontos[0]]];
  for (let i = 1; i < pontos.length; i++) {
    if (pontos[i].x - pontos[i - 1].x > limiar) trechos.push([]);
    trechos.at(-1).push(pontos[i]);
  }
  return trechos;
}

/**
 * Primeiro ponto de cada dia (fuso local), a partir do segundo dia da série —
 * é onde vai o divisor. Quem desenha decide se o rótulo cabe, porque isso
 * depende da escala do eixo.
 */
function inicioDeCadaDia(pontos) {
  const marcos = [];
  let diaAnterior = null;
  for (const p of pontos) {
    const dia = p.x.toLocaleDateString('pt-BR');
    if (diaAnterior !== null && dia !== diaAnterior) {
      marcos.push({ t: p.x.getTime(), rotulo: p.x.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) });
    }
    diaAnterior = dia;
  }
  return marcos;
}

/** Gráfico de linha SVG: série única (sem legenda), crosshair + tooltip.
 *  `marcadores` opcionais ({ x: Date, y, tipo: 'COMPRA'|'VENDA' }) viram
 *  triângulos na mesma escala e entram no percurso do crosshair/teclado. */
function desenharLinha(container, pontosEntrada, cor, marcadores = []) {
  container.textContent = '';
  // O eixo ordinal faz busca binária no tempo: ordem crescente deixou de ser
  // detalhe e virou pré-condição. Ordenar aqui (n ≤ 150) custa nada e tira a
  // dependência de quem monta a série lembrar de ordenar.
  const pontos = [...pontosEntrada].sort((a, b) => a.x - b.x);
  if (pontos.length < 2) {
    const vazio = document.createElement('p');
    vazio.className = 'grafico-vazio';
    vazio.textContent = 'Ainda não há dados suficientes — cada análise do bot adiciona um ponto.';
    container.append(vazio);
    return;
  }

  const L = 640, A = 260;
  const m = { topo: 18, dir: 14, base: 30, esq: 58 };
  const largura = L - m.esq - m.dir;
  const altura = A - m.topo - m.base;

  const xs = pontos.map((p) => p.x.getTime());
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  // Só marcadores dentro da janela da série (operações mais antigas ficam de fora).
  const marcas = marcadores.filter((mk) => {
    const t = mk.x.getTime();
    return Number.isFinite(t) && t >= xMin && t <= xMax;
  });
  const ys = [...pontos.map((p) => p.y), ...marcas.map((mk) => mk.y)];
  const ticks = escalaBonita(Math.min(...ys), Math.max(...ys));
  const yMin = ticks[0], yMax = ticks.at(-1);

  // EIXO X ORDINAL (não proporcional ao tempo): cada ponto ocupa um passo
  // igual, então a noite e o fim de semana — em que não houve negociação —
  // simplesmente não ocupam espaço. É como fazem as plataformas de trading.
  // O preço da tela é o que interessa; hora vazia só empurra o gráfico para
  // longe. `px` continua recebendo TEMPO: quem chama não muda, e um marcador
  // de operação entre dois pontos cai interpolado no lugar certo.
  const n = xs.length;
  const posOrdinal = (t) => {
    if (t <= xs[0]) return 0;
    if (t >= xs[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const meio = (lo + hi) >> 1;
      if (xs[meio] <= t) lo = meio; else hi = meio;
    }
    const vao = xs[hi] - xs[lo];
    return lo + (vao > 0 ? (t - xs[lo]) / vao : 0);
  };
  const px = (t) => m.esq + (posOrdinal(t) / Math.max(n - 1, 1)) * largura;
  const py = (v) => m.topo + (1 - (v - yMin) / (yMax - yMin || 1)) * altura;

  const svg = el('svg', { viewBox: `0 0 ${L} ${A}`, role: 'img' });

  for (const t of ticks) {
    svg.append(el('line', { x1: m.esq, x2: L - m.dir, y1: py(t), y2: py(t), stroke: 'var(--grade)', 'stroke-width': 1 }));
    const rot = el('text', { x: m.esq - 8, y: py(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--tinta-mutada)' });
    rot.textContent = fmtMoeda(moedaTela).compacto.format(t);
    svg.append(rot);
  }

  const fmtX = (d) => d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  // O rótulo do meio é o ponto do MEIO DA SÉRIE, não o instante médio: no eixo
  // ordinal os dois não coincidem, e o instante médio cairia fora do centro.
  const tMeio = pontos[Math.floor((pontos.length - 1) / 2)].x.getTime();
  for (const [t, ancora] of [[xMin, 'start'], [tMeio, 'middle'], [xMax, 'end']]) {
    const rot = el('text', { x: px(t), y: A - 8, 'text-anchor': ancora, 'font-size': 11, fill: 'var(--tinta-mutada)' });
    rot.textContent = fmtX(new Date(t));
    svg.append(rot);
  }

  // Divisores de dia: uma linha discreta no PRIMEIRO ponto de cada dia novo.
  // Desenhados antes da série para ficarem por baixo dela.
  const divisores = inicioDeCadaDia(pontos);
  // O rótulo só entra se couber até o divisor seguinte. A medida é em PIXEIS
  // (via px, que já é ordinal) — medir em tempo daria errado num eixo onde o
  // tempo não é proporcional.
  divisores.forEach((dv, i) => {
    const seguinte = divisores[i + 1];
    dv.cabe = !seguinte || px(seguinte.t) - px(dv.t) >= 34;
  });
  for (const { t, rotulo, cabe } of divisores) {
    svg.append(el('line', {
      x1: px(t), x2: px(t), y1: m.topo, y2: m.topo + altura,
      stroke: 'var(--eixo)', 'stroke-width': 1, 'stroke-dasharray': '3 4', opacity: 0.75,
    }));
    if (cabe) {
      const rot = el('text', {
        x: px(t) + 4, y: m.topo + 11, 'font-size': 10, fill: 'var(--tinta-mutada)',
      });
      rot.textContent = rotulo;
      svg.append(rot);
    }
  }

  // A série é quebrada onde o mercado ficou fechado: unir os dois lados
  // desenharia uma reta longa que NÃO existiu como preço — o gráfico estaria
  // inventando um movimento. Cada trecho vira um path próprio.
  const trechos = segmentarPorLacuna(pontos);
  for (const trecho of trechos) {
    if (trecho.length === 1) {
      // Ponto solitário entre duas lacunas: sem bolinha ele sumiria do gráfico.
      svg.append(el('circle', {
        cx: px(trecho[0].x.getTime()), cy: py(trecho[0].y), r: 2, fill: cor,
      }));
      continue;
    }
    const d = trecho.map((p, i) => `${i ? 'L' : 'M'}${px(p.x.getTime()).toFixed(1)},${py(p.y).toFixed(1)}`).join('');
    if (yMin >= 0) {
      const x0 = px(trecho[0].x.getTime()).toFixed(1);
      const x1 = px(trecho.at(-1).x.getTime()).toFixed(1);
      svg.append(el('path', { d: `${d}L${x1},${py(yMin)}L${x0},${py(yMin)}Z`, fill: cor, opacity: 0.1 }));
    }
    svg.append(el('path', {
      d, fill: 'none', stroke: cor, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }
  const fim = pontos.at(-1);
  svg.append(el('circle', { cx: px(fim.x.getTime()), cy: py(fim.y), r: 4, fill: cor, stroke: 'var(--superficie)', 'stroke-width': 2 }));

  const rotFim = el('text', {
    x: Math.min(px(fim.x.getTime()), L - m.dir) - 6, y: py(fim.y) - 10,
    'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: 'var(--tinta)',
  });
  rotFim.textContent = fmtMoeda(moedaTela).cheio.format(fim.y);
  svg.append(rotFim);

  // Marcadores de operação: triângulo ≥10px com anel de 2px da superfície
  // (destaca do traço da linha). ▲ aponta para cima = compra; ▼ = venda.
  for (const mk of marcas) {
    const marca = MARCA_OPERACAO[mk.tipo];
    if (!marca) continue;
    const cx = px(mk.x.getTime()), cy = py(mk.y);
    const pts = mk.tipo === 'COMPRA'
      ? `${cx},${cy - 6} ${cx + 5.5},${cy + 4.5} ${cx - 5.5},${cy + 4.5}`
      : `${cx},${cy + 6} ${cx + 5.5},${cy - 4.5} ${cx - 5.5},${cy - 4.5}`;
    svg.append(el('polygon', {
      points: pts, fill: marca.cor,
      stroke: 'var(--superficie)', 'stroke-width': 2, 'paint-order': 'stroke',
    }));
  }

  const cruz = el('line', { y1: m.topo, y2: m.topo + altura, stroke: 'var(--eixo)', 'stroke-width': 1, visibility: 'hidden' });
  const foco = el('circle', { r: 4, fill: cor, stroke: 'var(--superficie)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cruz, foco);

  const dica = document.createElement('div');
  dica.className = 'dica';
  dica.hidden = true;
  const dicaValor = document.createElement('div');
  dicaValor.className = 'dica-valor';
  const chave = document.createElement('span');
  chave.className = 'chave-linha';
  chave.style.color = cor;
  const dicaNum = document.createElement('span');
  dicaValor.append(chave, dicaNum);
  const dicaHora = document.createElement('div');
  dicaHora.className = 'dica-hora';
  dica.append(dicaValor, dicaHora);

  container.append(svg, dica);
  container.tabIndex = 0;
  container.setAttribute('role', 'application');
  container.setAttribute('aria-label', 'Gráfico de linha; use as setas para percorrer os pontos');

  // Alvos do crosshair/teclado: pontos da linha + marcadores de operação
  // (o tooltip de um marcador diz o tipo e usa a cor dele).
  const alvos = [
    ...pontos.map((p) => ({ x: p.x, y: p.y, cor, rotulo: null })),
    ...marcas
      .filter((mk) => MARCA_OPERACAO[mk.tipo])
      .map((mk) => ({ x: mk.x, y: mk.y, cor: MARCA_OPERACAO[mk.tipo].cor, rotulo: MARCA_OPERACAO[mk.tipo].rotulo })),
  ].sort((a, b) => a.x - b.x);

  let idx = -1;
  const mostrar = (i) => {
    idx = Math.max(0, Math.min(alvos.length - 1, i));
    const p = alvos[idx];
    const cx = px(p.x.getTime());
    cruz.setAttribute('x1', cx); cruz.setAttribute('x2', cx);
    cruz.setAttribute('visibility', 'visible');
    foco.setAttribute('cx', cx); foco.setAttribute('cy', py(p.y));
    foco.setAttribute('fill', p.cor);
    foco.setAttribute('visibility', 'visible');
    chave.style.color = p.cor;
    dicaNum.textContent = (p.rotulo ? `${p.rotulo} · ` : '') + fmtMoeda(moedaTela).cheio.format(p.y);
    dicaHora.textContent = fmtX(p.x);
    dica.hidden = false;
    const rect = svg.getBoundingClientRect();
    dica.style.left = `${(cx / L) * rect.width}px`;
    dica.style.top = `${(py(p.y) / A) * rect.height}px`;
  };
  const esconder = () => {
    cruz.setAttribute('visibility', 'hidden');
    foco.setAttribute('visibility', 'hidden');
    dica.hidden = true;
    idx = -1;
  };

  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const xAlvo = ((ev.clientX - rect.left) / rect.width) * L;
    let melhor = 0, menor = Infinity;
    alvos.forEach((p, i) => {
      const dist = Math.abs(px(p.x.getTime()) - xAlvo);
      // Em quase-empate (±1px), o marcador de operação vence o ponto da linha.
      if (dist < menor - 1 || (dist < menor + 1 && p.rotulo)) { menor = dist; melhor = i; }
    });
    mostrar(melhor);
  });
  svg.addEventListener('pointerleave', esconder);
  container.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight') { mostrar(idx < 0 ? alvos.length - 1 : idx + 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowLeft') { mostrar(idx < 0 ? alvos.length - 1 : idx - 1); ev.preventDefault(); }
    else if (ev.key === 'Escape') esconder();
  });
  container.addEventListener('focus', () => mostrar(alvos.length - 1));
  container.addEventListener('blur', esconder);
}

/** Tabela alternativa (acessibilidade): últimos 20 pontos, mais recentes primeiro. */
function preencherTabelaDados(tabela, pontos) {
  tabela.textContent = '';
  const cab = tabela.createTHead().insertRow();
  for (const t of ['Horário', 'Valor']) {
    const th = document.createElement('th');
    th.textContent = t;
    cab.append(th);
  }
  const corpo = tabela.createTBody();
  for (const p of pontos.slice(-20).reverse()) {
    const linha = corpo.insertRow();
    linha.insertCell().textContent = p.x.toLocaleString('pt-BR');
    linha.insertCell().textContent = fmtMoeda(moedaTela).cheio.format(p.y);
  }
}

// ----------------------------------------------------------------- operações
const OPERACOES_NA_TABELA = 10;

function renderOperacoes() {
  if (rota.tipo !== 'ativo') return;
  // A assinatura traz 50 porque o GRÁFICO de preço marca cada uma delas; a
  // tabela mostra só as 10 mais recentes — o resto era poluição, e ninguém
  // rolava 50 linhas para reler uma operação de duas semanas atrás.
  const ops = (telaDados.operacoes ?? []).slice(0, OPERACOES_NA_TABELA);
  const corpo = $('tabela-operacoes').tBodies[0];
  corpo.textContent = '';
  $('operacoes-vazio').hidden = ops.length > 0;
  for (const op of ops) {
    const linha = corpo.insertRow();
    linha.insertCell().textContent = dataHora(op.horario);
    // Venda por stop-loss: quem decidiu foi o Motor, não a IA — a coluna Tipo
    // diz isso explicitamente (a mesma informação que separa a cor no gráfico).
    const celTipo = linha.insertCell();
    if (op.tipo === 'VENDA' && op.origem_decisao === 'motor_stop_loss') {
      celTipo.textContent = 'VENDA (stop-loss)';
      celTipo.className = 'venda-stop';
    } else if (op.tipo === 'VENDA' && op.origem_decisao === 'motor_trava_lucro') {
      // Trava de lucro (V8.11): o Motor realizou o ganho sozinho. Rotular junto
      // com a venda da IA esconderia quem está de fato realizando lucro aqui.
      celTipo.textContent = 'VENDA (trava de lucro)';
      celTipo.className = 'venda-trava';
    } else if (op.tipo === 'VENDA' && op.origem_decisao === 'ia_modo_vendas') {
      // Liquidação (V8): a IA decidiu, mas com prejuízo autorizado pelo modo —
      // e o dia da janela explica quanto de prejuízo era aceito ali.
      const dia = op.modo_vendas?.dia;
      celTipo.textContent = dia ? `VENDA (liquidação, dia ${dia})` : 'VENDA (liquidação)';
      celTipo.className = 'venda-liquidacao';
    } else {
      celTipo.textContent = op.tipo ?? '—';
    }
    linha.insertCell().textContent = dinheiro(op.preco);
    linha.insertCell().textContent = op.quantidade != null ? qtd(op.quantidade) : '—';
    linha.insertCell().textContent = dinheiro(op.valor);
    linha.insertCell().textContent = dinheiro(op.taxa);
    linha.insertCell().textContent = dinheiro(op.lucro_liquido);
    const celStatus = linha.insertCell();
    const rotulo = document.createElement('span');
    rotulo.className = `rotulo-status ${op.status ?? ''}`;
    rotulo.textContent = op.status ?? '—';
    celStatus.append(rotulo);
    linha.insertCell().textContent = op.modo ?? '—';
    const celJust = linha.insertCell();
    celJust.className = 'justificativa-celula';
    celJust.textContent = op.justificativa_ia ?? op.motivo_rejeicao ?? '';
    celJust.title = celJust.textContent;
  }
}

// ------------------------------------------------------------------ posições
const ROTULOS_STATUS_POSICAO = {
  ABERTA: 'aberta',
  MONITORANDO: 'monitorando',
  LUCRO: 'em lucro',
  VENDA: 'vendendo…',
};

function renderPosicoes() {
  if (rota.tipo !== 'ativo') return;
  const ativo = ativoSelecionado();
  const corpo = $('tabela-posicoes').tBodies[0];
  corpo.textContent = '';
  const tc = Number(ativo?.config?.taxa_compra_percentual ?? 1.5);
  const tv = Number(ativo?.config?.taxa_venda_percentual ?? 1.5);

  // Breakeven do LOTE — precisa dar exatamente o mesmo número que o bot usa,
  // senão a tela diz "ainda falta subir" enquanto o Motor já aprovaria a venda
  // (ou o contrário). Espelha regrasEngine.taxaCompraPercentualEfetiva +
  // precoMinimoVendaLucrativa (CLAUDE.md §10.4):
  //   · perna de COMPRA pela taxa que a corretora DE FATO cobrou, gravada no
  //     lote (`taxa_compra`, em dinheiro). É fato consumado; usar a estimativa
  //     da config no lugar dela infla o breakeven;
  //   · perna de VENDA pela config — essa ainda não aconteceu, e é a estimativa
  //     conservadora que sustenta o "nunca vender no prejuízo".
  // Lote sem `taxa_compra` (externo, manual, anterior à V6.3) cai na config.
  const taxaCompraEfetiva = (p) => {
    const custo = Number(p?.quantidade) * Number(p?.preco_compra);
    return Number.isFinite(p?.taxa_compra) && p.taxa_compra >= 0 && Number.isFinite(custo) && custo > 0
      ? (p.taxa_compra / custo) * 100
      : tc;
  };
  const precoMinimo = (p) =>
    Math.round(p.preco_compra * ((1 + taxaCompraEfetiva(p) / 100) / (1 - tv / 100)) * 100) / 100;

  const abertas = (telaDados.posicoes ?? [])
    .filter((p) => (p.modo ?? 'simulacao') === modoDoAtivo(ativo) && p.status !== 'FECHADA')
    .sort((a, b) => String(a.abertura).localeCompare(String(b.abertura)));
  $('posicoes-vazio').hidden = abertas.length > 0;
  for (const p of abertas) {
    const linha = corpo.insertRow();
    linha.insertCell().textContent = dataHora(p.abertura);
    linha.insertCell().textContent =
      p.origem === 'externa' ? 'externa (manual/depósito)' : p.origem === 'manual' ? 'manual (registrada por você)' : 'bot';
    const celStatus = linha.insertCell();
    const rotulo = document.createElement('span');
    rotulo.className = `rotulo-posicao ${p.status ?? ''}`;
    rotulo.textContent = ROTULOS_STATUS_POSICAO[p.status] ?? p.status ?? '—';
    celStatus.append(rotulo);
    linha.insertCell().textContent = p.quantidade != null ? qtd(p.quantidade) : '—';
    linha.insertCell().textContent = dinheiro(p.preco_compra);
    linha.insertCell().textContent = p.preco_compra != null ? dinheiro(precoMinimo(p)) : '—';
    // Chão da posição (V6.6): abaixo dele o Motor vende, mesmo no prejuízo.
    // "—" = posição sem stop (externa/manual/anterior à V6.6): só vende no lucro.
    const celStop = linha.insertCell();
    if (p.stop_loss != null) {
      celStop.textContent = dinheiro(p.stop_loss);
      celStop.className = 'venda-stop';
      if (p.stop_loss_motivo) celStop.title = p.stop_loss_motivo;
    } else {
      celStop.textContent = '—';
      celStop.title = 'sem stop-loss — esta posição só é vendida com lucro';
    }
    // Trava de lucro (V8.11): o segundo chão, o que REALIZA. "—" = ainda não
    // armou (o lote não subiu o bastante), e nesse caso ninguém vai realizar
    // esse lucro sozinho — é a faixa em que a decisão da IA vale mais.
    const celTrava = linha.insertCell();
    if (p.trava_lucro != null) {
      celTrava.textContent = dinheiro(p.trava_lucro);
      celTrava.className = 'venda-trava';
      celTrava.title = p.preco_maximo != null
        ? `o robô vende aqui e realiza o lucro. Topo da posição: ${dinheiro(p.preco_maximo)}`
        : 'o robô vende aqui e realiza o lucro';
    } else {
      celTrava.textContent = '—';
      celTrava.title = 'a trava ainda não armou: o lote não subiu o bastante acima do preço mínimo para lucrar';
    }
    const celLucro = linha.insertCell();
    celLucro.textContent = dinheiro(p.lucro_se_vender_agora);
    if (p.lucro_se_vender_agora != null) {
      celLucro.className = p.lucro_se_vender_agora > 0 ? 'valor-positivo' : 'valor-negativo';
    }
  }
}

// ------------------------------------ parâmetros de TODOS os ativos (V8.16)
// Uma tabela com uma linha por ativo e uma coluna por parâmetro, na mesma ordem
// da Visão geral. Substituiu o formulário "Configurações do ativo", que vivia na
// tela de cada ativo: equilibrar orçamento, folga do stop e trava de lucro é
// decisão ENTRE ativos, e um formulário por tela obrigava a decorar o número de
// um para digitar o do outro.
//
// Duas regras que o formulário antigo não tinha:
//   - só o que MUDOU é gravado (merge por campo). Ativo que nunca teve
//     `trava_lucro_gatilho_percentual` não ganha um só por aparecer na tabela —
//     o que a coluna mostra nesse caso é o padrão do Motor, não um valor dele.
//   - nada é salvo por engano: a célula mexida fica destacada e a gravação só
//     acontece no botão.
//
// (O formulário antigo tinha um defeito que morreu com ele: os dois campos da
// trava de lucro eram exibidos e nunca gravados — o objeto do submit não os
// incluía, então editá-los na tela não mudava nada no robô.)
const COLUNAS_PARAMETROS = [
  {
    chave: 'ativo', rotulo: 'Ligado', tipo: 'bool', padrao: true,
    titulo: 'O robô analisa e opera este ativo',
  },
  {
    chave: 'modo_simulacao', rotulo: 'Simulação', tipo: 'bool', padrao: true,
    titulo: 'Marcado = ordens fictícias. DESMARCADO = ordens REAIS na plataforma',
  },
  {
    chave: 'tempo_entre_analises_minutos', rotulo: 'Análise (min)', padrao: 15, min: 1, step: 1,
    titulo: 'De quanto em quanto tempo o robô olha este ativo',
  },
  {
    chave: 'percentual_minimo_variacao', rotulo: 'Var. mín. (%)', padrao: 0.3, min: 0, step: 0.01,
    titulo: 'Quanto o preço precisa ter andado desde a última análise para valer a pena chamar a IA de novo',
  },
  {
    chave: 'percentual_max_diferenca_execucao', rotulo: 'Diverg. máx. (%)', padrao: 1, min: 0, step: 0.1,
    titulo: 'Diferença máxima aceita entre o preço que a IA analisou e o preço na hora de executar',
  },
  {
    chave: 'tempo_reset_dias', rotulo: 'Reset (dias)', padrao: 7, min: 1, step: 1,
    titulo: 'Sem nenhuma operação por este tempo, a IA recebe o sinal de recomeçar a análise do zero',
  },
  {
    chave: 'taxa_compra_percentual', rotulo: 'Taxa compra (%)', padrao: 1.5, min: 0, step: 0.01,
    titulo: 'Taxa que a plataforma cobra na compra — entra no cálculo do preço mínimo de venda lucrativa',
  },
  {
    chave: 'taxa_venda_percentual', rotulo: 'Taxa venda (%)', padrao: 1.5, min: 0, step: 0.01,
    titulo: 'Taxa que a plataforma cobra na venda — entra no cálculo do lucro líquido',
  },
  {
    chave: 'limite_perda_diaria_percentual', rotulo: 'Perda diária (%)', padrao: 3, min: 0, step: 0.1,
    titulo: 'Queda do patrimônio da plataforma no dia que bloqueia compras novas. 0 desativa',
  },
  {
    chave: 'orcamento_percentual', rotulo: 'Orçamento (%)', padrao: 100, min: 0, max: 100, step: 1,
    titulo: 'Fatia do patrimônio da plataforma que este ativo pode ocupar (por modo)',
  },
  {
    chave: 'stop_loss_max_distancia_percentual', rotulo: 'Stop dist. máx. (%)', padrao: 15, min: 0.1, max: 90, step: 0.5,
    titulo: 'O chão mais longe do preço que a IA pode pedir na compra',
  },
  {
    chave: 'stop_loss_trailing_percentual', rotulo: 'Folga do stop (%)', padrao: 2, min: 0.1, max: 50, step: 0.1,
    titulo: 'Distância MÍNIMA entre o preço e o chão, e a distância em que o robô sobe o chão sozinho quando a posição está em lucro. Chão que a IA peça mais perto que isso é recusado',
  },
  {
    chave: 'trava_lucro_gatilho_percentual', rotulo: 'Trava gatilho (%)', padrao: 1, min: 0, max: 50, step: 0.1,
    titulo: 'Quanto a posição precisa subir acima do ponto de empate para o robô armar a trava de lucro. 0 desliga a trava neste ativo',
  },
  {
    chave: 'trava_lucro_devolucao_percentual', rotulo: 'Trava devol. (%)', padrao: 0.8, min: 0, max: 50, step: 0.1,
    titulo: 'Quanto do TOPO da posição o robô aceita devolver antes de vender e realizar o lucro. Menor = realiza mais cedo e mais vezes',
  },
  {
    chave: 'minimo_ordem_valor', rotulo: 'Ordem mín. (valor)', padrao: 10, min: 0, step: 0.01,
    titulo: 'Menor valor de ordem aceito pela plataforma, na moeda dela',
  },
  {
    chave: 'minimo_ordem_quantidade', rotulo: 'Ordem mín. (qtd)', padrao: 0.00001, min: 0, step: 0.00000001,
    titulo: 'Menor quantidade de ordem aceita pela plataforma',
  },
];

// Ativos com alteração pendente: `plataforma/ativo` → Map(coluna → valor novo).
// Enquanto tiver alguém aqui dentro, o render NÃO reescreve a tabela — senão um
// snapshot do Firestore apagaria o que está sendo digitado.
const parametrosPendentes = new Map();

const chaveAtivo = (pid, aid) => `${pid}/${aid}`;

/** Valor em vigor de uma coluna: o do ativo ou, na falta dele, o padrão. */
function valorParametro(config, coluna) {
  const v = config?.[coluna.chave];
  if (coluna.tipo === 'bool') return v === undefined ? coluna.padrao : v !== false;
  return v === undefined || v === null ? coluna.padrao : v;
}

/** Linhas da tabela na ordem da Visão geral: por plataforma, ativo A→Z. */
function linhasDaTabelaParametros() {
  const linhas = [];
  for (const [pid, p] of plataformas) {
    const ordenados = [...p.ativos.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (ordenados.length === 0) continue;
    linhas.push({ grupo: true, pid, nome: p.dados?.nome || pid, moeda: p.dados?.moeda ?? 'BRL' });
    for (const [aid, ativo] of ordenados) linhas.push({ grupo: false, pid, aid, ativo });
  }
  return linhas;
}

function renderParametros() {
  if (rota.tipo !== 'parametros') return;
  const tabela = $('tabela-parametros');
  if (!tabela) return;

  // Cabeçalho montado a partir da MESMA lista que monta as células: coluna nova
  // nunca sai desalinhada do valor que ela edita.
  const cabecalho = tabela.tHead.rows[0];
  if (cabecalho.cells.length === 0) {
    const primeira = document.createElement('th');
    primeira.textContent = 'Ativo';
    primeira.className = 'coluna-fixa';
    cabecalho.append(primeira);
    for (const coluna of COLUNAS_PARAMETROS) {
      const th = document.createElement('th');
      th.textContent = coluna.rotulo;
      th.title = coluna.titulo;
      cabecalho.append(th);
    }
  }

  // Com edição em curso a tabela NÃO é remontada (um snapshot do Firestore
  // apagaria o que está sendo digitado) — mas a soma continua sendo refeita.
  if (parametrosPendentes.size > 0) {
    renderOrcamentosParametros();
    renderAvisoTrava();
    return;
  }

  const corpo = tabela.tBodies[0];
  corpo.textContent = '';
  for (const linha of linhasDaTabelaParametros()) {
    if (linha.grupo) {
      const tr = corpo.insertRow();
      tr.className = 'linha-grupo-plataforma';
      const td = tr.insertCell();
      td.colSpan = COLUNAS_PARAMETROS.length + 1;
      td.textContent = `${linha.nome} · ${linha.moeda}`;
      continue;
    }
    const { pid, aid, ativo } = linha;
    const tr = corpo.insertRow();
    tr.dataset.chave = chaveAtivo(pid, aid);
    if (ativo.config?.ativo === false) tr.className = 'linha-desligada';

    const celNome = tr.insertCell();
    celNome.className = 'coluna-fixa';
    const alvo = document.createElement('a');
    alvo.href = `#/ativo/${pid}/${aid}`;
    alvo.textContent = `${ativo.manifest?.nome || aid} (${aid})`;
    celNome.append(alvo);

    for (const coluna of COLUNAS_PARAMETROS) {
      const celula = tr.insertCell();
      const campo = document.createElement('input');
      const valor = valorParametro(ativo.config, coluna);
      if (coluna.tipo === 'bool') {
        campo.type = 'checkbox';
        campo.checked = valor === true;
      } else {
        campo.type = 'number';
        campo.value = valor;
        if (coluna.min !== undefined) campo.min = coluna.min;
        if (coluna.max !== undefined) campo.max = coluna.max;
        campo.step = coluna.step;
      }
      campo.title = coluna.titulo;
      // O valor SALVO viaja no próprio campo: é com ele que a edição é comparada
      // para saber o que gravar (e o que o botão Desfazer devolve).
      campo.dataset.salvo = String(valor);
      campo.dataset.coluna = coluna.chave;
      campo.addEventListener('input', aoEditarParametro);
      campo.addEventListener('change', aoEditarParametro);
      celula.append(campo);
    }
  }

  // DEPOIS de remontar as linhas: é ela que pinta as células de orçamento dos
  // grupos acima de 100%, e as células de agora acabaram de nascer limpas.
  renderOrcamentosParametros();
  renderAvisoTrava();
}

/** Valor atual de um campo, no tipo certo (número ou booleano). */
const lerCampoParametro = (campo) => (campo.type === 'checkbox' ? campo.checked : Number(campo.value));

function aoEditarParametro(ev) {
  const campo = ev.currentTarget;
  const chave = campo.closest('tr')?.dataset.chave;
  if (!chave) return;

  const salvo = campo.type === 'checkbox' ? campo.dataset.salvo === 'true' : Number(campo.dataset.salvo);
  const atual = lerCampoParametro(campo);
  const mudou = !Object.is(atual, salvo);
  campo.parentElement.classList.toggle('celula-alterada', mudou);

  const pendentes = parametrosPendentes.get(chave) ?? new Map();
  if (mudou) pendentes.set(campo.dataset.coluna, atual);
  else pendentes.delete(campo.dataset.coluna);
  if (pendentes.size > 0) parametrosPendentes.set(chave, pendentes);
  else parametrosPendentes.delete(chave);

  renderBarraParametros();
  renderOrcamentosParametros(); // o orçamento digitado muda a soma na hora
  renderAvisoTrava();
}

/**
 * A invariante da trava de lucro: **gatilho > devolução** (V8.19).
 *
 * Se a devolução for maior ou igual ao gatilho, o lote arma em
 * breakeven × (1+gatilho) e a trava pediria um valor ABAIXO do empate — o piso
 * do breakeven segura, e ela nasceria exatamente ali, sem nunca poder disparar.
 * Desde a V8.19 o Motor simplesmente não arma nesse caso, então o efeito prático
 * de violar a regra é **ficar sem trava nenhuma** naquele ativo.
 *
 * Esta tela é a primeira que consegue gravar esses dois campos — o formulário
 * antigo os exibia e nunca os salvava —, então é aqui que o aviso tem de estar.
 */
function renderAvisoTrava() {
  const alvo = $('parametros-aviso-trava');
  if (!alvo) return;
  const problemas = [];
  for (const [pid, p] of plataformas) {
    for (const [aid, a] of p.ativos) {
      const pendente = parametrosPendentes.get(chaveAtivo(pid, aid));
      const valor = (coluna, salvo) => Number(pendente?.has(coluna) ? pendente.get(coluna) : salvo);
      const g = valor('trava_lucro_gatilho_percentual', a.config?.trava_lucro_gatilho_percentual ?? 1);
      const d = valor('trava_lucro_devolucao_percentual', a.config?.trava_lucro_devolucao_percentual ?? 0.8);
      if (g > 0 && d > 0 && g <= d) problemas.push(`${aid} (${pid}): gatilho ${g}% ≤ devolução ${d}%`);
    }
  }
  alvo.hidden = problemas.length === 0;
  alvo.textContent = problemas.length === 0
    ? ''
    : `⚠️ Trava de lucro sem efeito em ${problemas.length} ativo(s) — o GATILHO precisa ser MAIOR que a DEVOLUÇÃO, ` +
      'senão a trava nasceria no ponto de empate e o robô não a arma (ela ficaria sem poder vender nunca). ' +
      `Corrija: ${problemas.join(' · ')}.`;
}

function renderBarraParametros() {
  const quantos = parametrosPendentes.size;
  const campos = [...parametrosPendentes.values()].reduce((n, m) => n + m.size, 0);
  $('btn-parametros-salvar').disabled = quantos === 0;
  $('btn-parametros-desfazer').disabled = quantos === 0;
  $('parametros-resumo').textContent = quantos === 0
    ? ''
    : `${campos} campo(s) alterado(s) em ${quantos} ativo(s) — ainda NÃO salvos`;
}

/**
 * Soma dos orçamentos por plataforma E por modo, já com o que está sendo
 * digitado. A conta mora em `orcamentos.js` (pura e testada); aqui só se
 * desenha o resultado.
 *
 * O vermelho aparece em DOIS lugares de propósito: na linha da soma e nas
 * PRÓPRIAS células de orçamento do grupo que estourou. Só na soma não bastava —
 * ela fica fora da tabela, e numa lista com cinco plataformas o aviso some do
 * campo de visão exatamente enquanto se digita o número que o causou.
 */
function renderOrcamentosParametros() {
  const alvo = $('parametros-orcamentos');
  if (!alvo) return;
  alvo.textContent = '';

  const linhas = somarOrcamentos({
    plataformas,
    valorEditado: (pid, aid, coluna, salvo) => {
      const pendente = parametrosPendentes.get(chaveAtivo(pid, aid));
      return pendente?.has(coluna) ? pendente.get(coluna) : salvo;
    },
  });

  const estourados = new Set();
  for (const linha of linhas) {
    const item = document.createElement('p');
    item.className = linha.excedeu ? 'orcamento-linha estourado' : 'orcamento-linha';
    item.textContent = textoOrcamento(linha);
    alvo.append(item);
    if (linha.excedeu) for (const aid of linha.ativos) estourados.add(chaveAtivo(linha.pid, aid));
  }

  // Pinta a célula do orçamento de cada ativo que entra num grupo estourado —
  // é ela que precisa mudar, e é ela que está debaixo do cursor.
  const tabela = $('tabela-parametros');
  for (const tr of tabela?.tBodies[0]?.rows ?? []) {
    const campo = tr.querySelector('input[data-coluna="orcamento_percentual"]');
    if (!campo) continue;
    campo.parentElement.classList.toggle('celula-estourada', estourados.has(tr.dataset.chave));
  }
}
aoEvento('btn-parametros-desfazer', 'click', () => {
  parametrosPendentes.clear();
  renderBarraParametros();
  renderParametros();
  $('parametros-status').textContent = 'alterações descartadas';
});

aoEvento('btn-parametros-salvar', 'click', async () => {
  const status = $('parametros-status');
  const pendentes = [...parametrosPendentes.entries()];
  if (pendentes.length === 0) return;
  status.textContent = 'salvando…';
  $('btn-parametros-salvar').disabled = true;

  let salvos = 0;
  try {
    for (const [chave, campos] of pendentes) {
      const [pid, aid] = chave.split('/');
      // MERGE por CAMPO: só o que mudou vai ao banco. Gravar o objeto inteiro
      // plantaria os padrões da tela em ativos que nunca tiveram aquele campo —
      // armaria uma trava de lucro numa skin da Steam, por exemplo, sem ninguém
      // ter pedido.
      const config = Object.fromEntries(campos);
      await setDoc(doc(db, 'plataformas', pid, 'ativos', aid), { config }, { merge: true });
      salvos += 1;
    }
    parametrosPendentes.clear();
    avisarConfigMudou();
    renderBarraParametros();
    renderParametros();
    status.textContent = `${salvos} ativo(s) salvo(s) ✓ — valem no próximo ciclo do bot`;
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message} (as alterações continuam na tela)`;
    renderBarraParametros();
  }
});

// --------------------------- patrimônio da plataforma (tela da plataforma)
// O número é da PLATAFORMA, não de um ativo — mas quem o carimba é o histórico
// de cada ativo, uma vez por análise (`patrimonio_plataforma`). Para desenhar a
// curva da plataforma inteira, juntamos o histórico de TODOS os ativos dela e
// ficamos com um ponto por instante.
//
// Por MODO, e nunca os dois na mesma linha: simulação e real são carteiras
// separadas, com 100% de orçamento cada uma. Misturá-las desenharia um zigue-
// zague entre duas grandezas diferentes.
const PATRIMONIO_POR_ATIVO = 100; // pontos lidos por ativo (leitura é orçada)

let patrimonioModo = null; // null = escolhe sozinho o modo com dado mais recente
let patrimonioAssinado = null; // assinatura da lista de ativos já assinada
let cancelPatrimonio = [];

function cancelarPatrimonio() {
  cancelPatrimonio.forEach((fn) => fn());
  cancelPatrimonio = [];
  patrimonioAssinado = null;
}

/**
 * Garante que o histórico de todos os ativos da plataforma esteja assinado.
 * Chamada a cada render porque os ativos chegam DEPOIS da rota quando a página
 * abre direto em `#/plataforma/XX` — assinar só na troca de tela deixaria o
 * gráfico vazio para sempre nesse caminho.
 */
function garantirSeriePatrimonio() {
  if (rota.tipo !== 'plataforma') {
    if (cancelPatrimonio.length > 0) cancelarPatrimonio();
    return;
  }
  const p = plataformas.get(rota.plataforma);
  const ids = [...(p?.ativos.keys() ?? [])].sort();
  const assinatura = `${rota.plataforma}:${ids.join(',')}`;
  if (assinatura === patrimonioAssinado) return;

  cancelarPatrimonio();
  patrimonioAssinado = assinatura;
  telaDados.patrimonio = new Map();
  for (const aid of ids) {
    cancelPatrimonio.push(
      onSnapshot(
        query(
          collection(db, 'plataformas', rota.plataforma, 'ativos', aid, 'historico'),
          orderBy('horario', 'desc'),
          limit(PATRIMONIO_POR_ATIVO),
        ),
        (snap) => {
          telaDados.patrimonio?.set(
            aid,
            snap.docs
              .map((d) => d.data())
              .filter((h) => h.tipo === 'analise' && Number.isFinite(h.patrimonio_plataforma ?? h.patrimonio)),
          );
          renderPatrimonioPlataforma();
        },
      ),
    );
  }
}

/** Pontos { x, y } do modo pedido, de todos os ativos, sem instante repetido. */
function pontosPatrimonio(modo) {
  const porInstante = new Map();
  for (const entradas of telaDados.patrimonio?.values() ?? []) {
    for (const h of entradas) {
      if ((h.modo ?? 'simulacao') !== modo) continue;
      porInstante.set(h.horario, h.patrimonio_plataforma ?? h.patrimonio);
    }
  }
  return [...porInstante.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([horario, y]) => ({ x: new Date(horario), y }));
}

function renderPatrimonioPlataforma() {
  if (rota.tipo !== 'plataforma') return;
  const grafico = $('grafico-patrimonio');
  if (!grafico) return;

  const series = { real: pontosPatrimonio('real'), simulacao: pontosPatrimonio('simulacao') };
  // Sem escolha do dono, mostra o modo com o dado MAIS RECENTE: numa plataforma
  // só de simulação, abrir em "Real" mostraria um gráfico vazio de propósito.
  const ultimo = (modo) => series[modo].at(-1)?.x?.getTime() ?? -Infinity;
  const modo = patrimonioModo ?? (ultimo('real') >= ultimo('simulacao') ? 'real' : 'simulacao');
  for (const botao of $('patrimonio-modos').querySelectorAll('button')) {
    botao.classList.toggle('ativo', botao.dataset.modo === modo);
  }

  const pontos = series[modo];
  const moeda = plataformas.get(rota.plataforma)?.dados?.moeda ?? 'BRL';
  $('patrimonio-nota').textContent = pontos.length === 0
    ? `Nenhuma análise em ${modo === 'real' ? 'modo real' : 'simulação'} ainda — o patrimônio é carimbado a cada análise de um ativo desta plataforma.`
    : `Caixa + posições de todos os ativos da plataforma em ${modo === 'real' ? 'MODO REAL' : 'SIMULAÇÃO'}, em ${moeda}, a cada análise. Último: ${dinheiro(pontos.at(-1).y, moeda)}.`;

  desenharLinha(grafico, pontos, 'var(--serie-patrimonio)');
  preencherTabelaDados($('tabela-patrimonio'), pontos);
}

aoEvento('patrimonio-modos', 'click', (ev) => {
  const modo = ev.target?.dataset?.modo;
  if (!modo) return;
  patrimonioModo = modo;
  renderPatrimonioPlataforma();
});

// ------------------------------------------------------- "analisar agora"
// Grava uma MARCA (um ISO) no doc do ativo e avisa que a config mudou — o bot
// derruba o catálogo no próximo minuto, lê a marca e roda o ciclo deste ativo
// fora da vez, pulando também o filtro de variação mínima (senão a análise que
// o dono acabou de pedir sairia como "sem variação"). Nenhuma leitura nova no
// tick do bot: a marca pega a carona que já existe.
aoEvento('btn-analisar-agora', 'click', async () => {
  if (rota.tipo !== 'ativo') return;
  const status = $('analisar-agora-status');
  const ativo = ativoSelecionado();
  if (ativo?.config?.ativo === false) {
    status.textContent = 'este ativo está DESLIGADO — ligue em Parâmetros para o robô analisá-lo';
    return;
  }
  status.textContent = 'pedindo ao bot…';
  try {
    await setDoc(
      doc(db, 'plataformas', rota.plataforma, 'ativos', rota.ativo),
      { analise_solicitada_em: new Date().toISOString() },
      { merge: true },
    );
    avisarConfigMudou();
    status.textContent = 'pedido enviado ✓ — a análise sai no próximo minuto e o relógio reinicia nela';
  } catch (e) {
    status.textContent = `erro: ${e.code ?? e.message}`;
  }
});

// ------------------------------------- contas espelho (V8.18, fase 1)
// Contas adicionais da MESMA corretora. Aqui a tela só CADASTRA e MOSTRA: quem
// lê o saldo é o bot (a Steam e as corretoras não liberam CORS, e a credencial
// nem sequer é legível pelo navegador — ver firestore.rules).
//
// A credencial vai para `contas/{c}/dados/api`, que é SÓ-ESCRITA. O que a tela
// exibe vem de `api_meta`, o espelho mascarado que o BOT publica — exatamente o
// mesmo desenho da chave da conta principal.

function renderContas() {
  if (rota.tipo !== 'plataforma') return;
  const tabela = $('tabela-contas');
  if (!tabela) return;
  const contas = telaDados.contas ?? [];
  const corpo = tabela.tBodies[0];
  corpo.textContent = '';
  $('contas-vazio').hidden = contas.length > 0;

  // Conta que aponta para a MESMA carteira da principal: em sombra é
  // inofensivo, em ordem de verdade DOBRARIA a compra. O aviso fica no topo,
  // em vermelho, porque é a única coisa desta tela que pode custar dinheiro.
  const duplicadas = contas.filter((c) => c.estado?.mesma_conta_da_principal);
  const aviso = $('contas-aviso-mesma');
  if (aviso) {
    aviso.hidden = duplicadas.length === 0;
    aviso.textContent = duplicadas.length === 0
      ? ''
      : `⛔ ${duplicadas.map((c) => c.nome).join(', ')} ${duplicadas.length === 1 ? 'tem' : 'têm'} ` +
        'exatamente o mesmo saldo da sua conta — é a MESMA conta da corretora, com outra chave. ' +
        'Em sombra não faz mal nenhum. Em ordem de verdade (fase 3), cada compra sairia DUAS VEZES ' +
        'na sua carteira. Não ligue o modo real nesta conta.';
  }

  for (const c of contas) {
    const linha = corpo.insertRow();
    if (!c.ativa) linha.className = 'linha-desligada';

    linha.insertCell().textContent = `${c.nome} (${c.id})`;

    const celEstado = linha.insertCell();
    const ponto = document.createElement('span');
    ponto.className = `ponto-estado ${c.ativa ? 'ligado' : 'desligado'}`;
    celEstado.append(ponto, document.createTextNode(c.ativa ? 'ativa' : 'pausada'));

    const celModo = linha.insertCell();
    const badge = document.createElement('span');
    badge.className = `badge ${c.modo_simulacao ? 'simulacao' : 'real'}`;
    badge.textContent = c.modo_simulacao ? 'simulação' : 'REAL';
    celModo.append(badge);

    const conexao = c.estado?.conexao;
    const celConexao = linha.insertCell();
    celConexao.textContent = resumoConexao(conexao, dataHora);
    celConexao.className = estadoConexao(conexao).classe;

    const saldo = c.estado?.saldo;
    linha.insertCell().textContent = saldo
      ? `${dinheiro(saldo.saldo_moeda, saldo.moeda)}${Object.keys(saldo.saldos ?? {}).length ? ` + ${Object.entries(saldo.saldos).map(([s, q]) => `${qtd(q)} ${s}`).join(', ')}` : ''}`
      : '—';

    const meta = c.apiMeta ?? {};
    linha.insertCell().textContent = Object.entries(meta)
      .filter(([, v]) => v)
      .map(([campo, v]) => `${campo}: ${v}`)
      .join(' · ') || 'não configuradas';

    const celAcoes = linha.insertCell();
    const alternar = document.createElement('button');
    alternar.type = 'button';
    alternar.className = 'botao-fantasma';
    alternar.textContent = c.ativa ? 'Pausar' : 'Ativar';
    alternar.addEventListener('click', async () => {
      alternar.disabled = true;
      try {
        await setDoc(doc(db, 'plataformas', rota.plataforma, 'contas', c.id), { ativa: !c.ativa }, { merge: true });
        avisarConfigMudou();
      } catch (e) {
        $('conta-status').textContent = `erro: ${e.code ?? e.message}`;
      }
      alternar.disabled = false;
    });
    celAcoes.append(alternar);
  }
}

/**
 * Ordens SOMBRA (fase 2): o que cada conta teria comprado. Vêm de
 * `ativos/{A}/contas/{C}/operacoes`, uma coleção por conta e por ativo — a
 * tela junta todas e mostra as mais recentes.
 */
function renderSombras() {
  if (rota.tipo !== 'plataforma') return;
  const tabela = $('tabela-sombras');
  if (!tabela) return;
  const sombras = [...(telaDados.sombras ?? new Map()).values()]
    .flat()
    .sort((a, b) => String(b.horario ?? '').localeCompare(String(a.horario ?? '')))
    .slice(0, 20);

  const corpo = tabela.tBodies[0];
  corpo.textContent = '';
  $('sombras-vazio').hidden = sombras.length > 0;
  const moeda = plataformas.get(rota.plataforma)?.dados?.moeda ?? 'BRL';

  for (const s of sombras) {
    const linha = corpo.insertRow();
    linha.insertCell().textContent = dataHora(s.horario);
    linha.insertCell().textContent = s.conta;
    linha.insertCell().textContent = s.ativo;
    linha.insertCell().textContent = s.aprovada ? dinheiro(s.valor, moeda) : '—';
    linha.insertCell().textContent = dinheiro(s.principal?.valor ?? null, moeda);
    linha.insertCell().textContent = dinheiro(s.saldo_conta, moeda);
    const celResultado = linha.insertCell();
    celResultado.textContent = s.aprovada ? '✅ compraria' : `❌ ${s.motivo ?? 'recusada'}`;
    celResultado.className = s.aprovada ? 'valor-positivo' : 'justificativa-celula';
    if (!s.aprovada) celResultado.title = s.motivo ?? '';
  }
}

/** Os campos de credencial da conta são os MESMOS da plataforma (mesmo conector). */
let contaCamposMontadosPara = null;
function montarCamposContaApi(conector) {
  const alvo = $('conta-campos-api');
  if (!alvo || contaCamposMontadosPara === `${rota.plataforma}/${conector}`) return;
  contaCamposMontadosPara = `${rota.plataforma}/${conector}`;
  alvo.textContent = '';
  const receita = CAMPOS_API_CORRETORA[conector];
  $('conta-cred-legenda').textContent = receita
    ? receita.titulo.replace('Credenciais da corretora', 'Credenciais desta conta')
    : 'Credenciais desta conta';
  if (!receita) {
    const p = document.createElement('p');
    p.className = 'texto-secundario';
    p.textContent = 'Esta plataforma não tem campos de credencial cadastrados no painel.';
    alvo.append(p);
    return;
  }
  for (const { campo, rotulo } of receita.campos) {
    const label = document.createElement('label');
    label.textContent = rotulo;
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.dataset.campo = campo;
    label.append(input);
    alvo.append(label);
  }
}

aoEvento('form-nova-conta', 'submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'plataforma') return;
  const status = $('conta-status');
  const id = $('conta-id').value.trim().toLowerCase();
  const nome = $('conta-nome').value.trim();

  if (!/^[a-z0-9_-]{1,20}$/.test(id)) {
    status.textContent = 'identificador inválido — use letras minúsculas, números, hífen ou _';
    return;
  }
  if ((telaDados.contas ?? []).some((c) => c.id === id)) {
    status.textContent = `já existe uma conta com o id "${id}"`;
    return;
  }
  const api = {};
  for (const input of $('conta-campos-api').querySelectorAll('input[data-campo]')) {
    if (input.value.trim()) api[input.dataset.campo] = input.value.trim();
  }
  if (Object.keys(api).length === 0) {
    status.textContent = 'informe ao menos uma credencial — sem ela o robô não consegue nem ler o saldo';
    return;
  }

  status.textContent = 'cadastrando…';
  try {
    // A conta nasce em SIMULAÇÃO: a ordem de verdade é um ato deliberado, nunca
    // o que acontece porque alguém esqueceu de configurar um campo.
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'contas', id), {
      nome, ativa: true, modo_simulacao: true, criada_em: new Date().toISOString(),
    });
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'contas', id, 'dados', 'api'), api);
    avisarConfigMudou();
    $('conta-id').value = '';
    $('conta-nome').value = '';
    for (const input of $('conta-campos-api').querySelectorAll('input[data-campo]')) input.value = '';
    status.textContent = `${nome} cadastrada ✓ — o robô lê o saldo dela na próxima hora`;
  } catch (e) {
    status.textContent = `erro ao cadastrar: ${e.code ?? e.message}`;
  }
});

// ------------------------------------------------------- exclusão de ativo
/** Apaga todos os docs de uma subcoleção (um a um — escala de hobby). */
async function excluirSubcolecao(caminho) {
  const snap = await getDocs(collection(db, ...caminho));
  for (const d of snap.docs) await deleteDoc(d.ref);
}

$('botao-excluir-ativo').addEventListener('click', async () => {
  if (rota.tipo !== 'ativo') return;
  const status = $('excluir-ativo-status');
  const ativo = ativoSelecionado();

  // Trava 1: só exclui ativo DESLIGADO (evita apagar algo que o bot está operando).
  if (ativo?.config?.ativo !== false) {
    status.textContent = 'desligue o ativo nas configurações (e salve) antes de excluir';
    return;
  }
  // Trava 2: confirmação digitada — exclusão apaga histórico/posições para sempre.
  const digitado = window.prompt(
    `EXCLUIR ${rota.ativo} apaga configurações, histórico, operações e posições PARA SEMPRE.\n\n` +
      `Para confirmar, digite: ${rota.ativo}`,
  );
  if (digitado === null) return; // cancelou o diálogo
  if (digitado.trim().toUpperCase() !== rota.ativo.toUpperCase()) {
    status.textContent = 'texto de confirmação não confere — exclusão cancelada';
    return;
  }

  status.textContent = 'excluindo… (pode levar um tempo se houver muito histórico)';
  try {
    const base = ['plataformas', rota.plataforma, 'ativos', rota.ativo];
    for (const sub of ['dados', 'historico', 'operacoes', 'posicoes']) {
      await excluirSubcolecao([...base, sub]);
    }
    await deleteDoc(doc(db, ...base));
    location.hash = '#/geral'; // o menu se atualiza sozinho via onSnapshot
  } catch (e) {
    status.textContent = `erro ao excluir: ${e.code ?? e.message}`;
  }
});

// ------------------------------------------------------ prompt e contexto
let promptEditando = false;
$('texto-prompt').addEventListener('focus', () => { promptEditando = true; });
$('texto-prompt').addEventListener('blur', () => { promptEditando = false; });
function renderPrompt() {
  $('prompt-versao').textContent = telaDados.prompt?.versao ? `(versão ${telaDados.prompt.versao})` : '';
  if (!promptEditando) $('texto-prompt').value = telaDados.prompt?.conteudo ?? '';
}
$('form-prompt').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'ativo') return;
  const status = $('prompt-status');
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'ativos', rota.ativo, 'dados', 'prompt'), {
      conteudo: $('texto-prompt').value,
      versao: (telaDados.prompt?.versao ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    });
    avisarConfigMudou();
    status.textContent = 'prompt salvo ✓';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

let contextoEditando = false;
$('texto-contexto').addEventListener('focus', () => { contextoEditando = true; });
$('texto-contexto').addEventListener('blur', () => { contextoEditando = false; });
function renderContexto() {
  $('contexto-atualizado').textContent = telaDados.contexto?.atualizado_em
    ? `Última edição: ${dataHora(telaDados.contexto.atualizado_em)}.`
    : '';
  // Validade definida pela IA (V6.2): informativo — some quando não há.
  const val = $('contexto-validade');
  const validadeAte = telaDados.contexto?.validade_ate;
  if (!telaDados.contexto?.texto?.trim() || !validadeAte) {
    val.textContent = validadeAte === null && telaDados.contexto?.texto?.trim()
      ? '⏳ A IA definirá a validade deste contexto na próxima análise.'
      : '';
  } else {
    const expirado = Date.parse(validadeAte) <= Date.now();
    val.textContent = expirado
      ? `⚠️ Contexto EXPIRADO em ${dataHora(validadeAte)} — não é mais enviado à IA. Reescreva para renová-lo.`
      : `✓ Válido até ${dataHora(validadeAte)} (definido pela IA). Reescrever o texto zera a validade.`;
  }
  if (!contextoEditando) $('texto-contexto').value = telaDados.contexto?.texto ?? '';
}
$('form-contexto').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'ativo') return;
  const status = $('contexto-status');
  status.textContent = 'salvando…';
  try {
    // Reescrever o contexto ZERA a validade (V6.2): a IA a redefine na próxima
    // análise. setDoc sem merge já sobrescreve o doc, mas deixamos explícito.
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'ativos', rota.ativo, 'dados', 'contexto'), {
      texto: $('texto-contexto').value,
      atualizado_em: new Date().toISOString(),
      validade_ate: null,
      validade_definida_em: null,
    });
    avisarConfigMudou();
    status.textContent = 'contexto salvo ✓ (a IA o recebe e define a validade na próxima análise)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

// -------------------------------------------------------- tela da plataforma
// O valor JÁ chega mascarado do bot ('…1234'): a chave em si nunca vem para o
// navegador. Antes esta função recebia o segredo inteiro e cortava os 4 últimos
// para exibir — o que escondia da TELA, não da rede nem do devtools.
const mascarar = (mascara) => (mascara ? `configurada (${mascara})` : 'não configurada');

// Campos de credencial POR CONECTOR: a tela monta os inputs conforme a
// corretora da plataforma (MB usa token id/secret; TT usa OAuth2).
const CAMPOS_API_CORRETORA = {
  mb: {
    titulo: 'Credenciais da corretora (Mercado Bitcoin)',
    campos: [
      { campo: 'api_key_id', rotulo: 'API Token ID da plataforma' },
      { campo: 'api_key_secret', rotulo: 'API Token Secret da plataforma' },
    ],
  },
  tt: {
    titulo: 'Credenciais da corretora (Tastytrade — OAuth2)',
    campos: [
      { campo: 'tt_client_id', rotulo: 'Client ID da OAuth Application' },
      { campo: 'tt_client_secret', rotulo: 'Client Secret da OAuth Application' },
      { campo: 'tt_refresh_token', rotulo: 'Refresh Token (Personal OAuth Grant — não expira)' },
      { campo: 'tt_account_id', rotulo: 'Número da conta (opcional — vazio usa a primeira)' },
    ],
  },
  bn: {
    titulo: 'Credenciais da corretora (Binance)',
    campos: [
      { campo: 'bn_api_key', rotulo: 'API Key (binance.com → API Management)' },
      { campo: 'bn_api_secret', rotulo: 'API Secret (mostrado só na criação da chave)' },
    ],
  },
  toro: {
    titulo: 'Dados de mercado (brapi.dev — a Toro não tem API)',
    campos: [
      { campo: 'brapi_token', rotulo: 'Token do brapi.dev (grátis — crie em brapi.dev/dashboard)' },
    ],
  },
};
let camposApiConstruidosPara = null; // 'plataforma/conector' já montado

function construirCamposApiCorretora(conector) {
  const chave = `${rota.plataforma}/${conector}`;
  if (camposApiConstruidosPara === chave) return;
  camposApiConstruidosPara = chave;

  const def = CAMPOS_API_CORRETORA[conector] ?? { titulo: 'Credenciais da corretora', campos: [] };
  const legenda = $('cred-corretora-legenda');
  legenda.textContent = '';
  legenda.append(`${def.titulo} `);
  const aviso = document.createElement('span');
  aviso.className = 'texto-secundario';
  aviso.textContent = '(deixe em branco para manter a atual)';
  legenda.append(aviso);

  const container = $('campos-api-corretora');
  container.textContent = '';
  for (const { campo, rotulo } of def.campos) {
    const label = document.createElement('label');
    label.textContent = rotulo;
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.dataset.campo = campo;
    label.append(input);
    container.append(label);
  }
}

function renderStatusPlataforma() {
  const estado = plataformas.get(rota.plataforma)?.estadoPlataforma ?? {};
  const conexao = estado.conexao ?? null;
  // TRÊS estados, não dois (§10.11): "conectada" nunca mais quer dizer só que
  // o bot conseguiu LER o saldo. Ver dashboard/public/conexaoStatus.js.
  const est = estadoConexao(conexao);
  const elConexao = $('status-conexao');
  elConexao.className = est.classe;
  elConexao.textContent = !conexao
    ? 'ainda não verificada — o bot testa na próxima rodada'
    : `${est.icone} ${est.titulo} (verificada em ${dataHora(conexao.verificado_em)})` +
      (est.detalhe ? ` — ${est.detalhe}` : '');

  const mercado = estado.mercado ?? null;
  $('status-mercado').textContent = !mercado
    ? '— (plataformas 24h não têm pregão)'
    : mercado.aberto
      ? `🟢 aberto${mercado.fecha_em ? ` — fecha às ${dataHora(mercado.fecha_em)}` : ''}`
      : `🔴 fechado (${mercado.estado ?? '—'})${mercado.abre_em ? ` — próxima abertura ${dataHora(mercado.abre_em)}` : ''}`;
}

function renderPlataforma() {
  if (rota.tipo !== 'plataforma') return;
  const p = plataformas.get(rota.plataforma);
  const api = telaDados.api ?? {};
  construirCamposApiCorretora(p?.dados?.conector ?? '');
  renderStatusPlataforma();
  renderCaixaManual();
  $('cfg-api-key-ia').placeholder = mascarar(api.api_key_ia);
  for (const input of $('campos-api-corretora').querySelectorAll('input')) {
    input.placeholder = mascarar(api[input.dataset.campo]);
  }
  const modelos = p?.dados?.modelos_ia;
  if (document.activeElement !== $('cfg-modelos-ia')) {
    $('cfg-modelos-ia').value = Array.isArray(modelos) ? modelos.join(', ') : '';
  }
  const receita = RECEITAS_NOVO_ATIVO[p?.dados?.conector];
  $('novo-ativo-dica').textContent = receita?.dica ?? 'Informe o código do ativo negociado nesta plataforma.';
}

// ------------------------------------- caixa manual (plataformas assistidas)
function renderCaixaManual() {
  const assistida = plataformaAssistida(rota.plataforma);
  $('cartao-caixa-manual').hidden = !assistida;
  if (!assistida) return;
  const carteira = plataformas.get(rota.plataforma)?.estadoPlataforma?.carteira_manual ?? null;
  $('caixa-manual-atual').textContent = carteira
    ? `Caixa atual: ${dinheiro(carteira.saldo_moeda ?? 0)} (atualizado em ${dataHora(carteira.atualizada_em)})`
    : 'Caixa atual: — (ainda não informado)';
}

$('form-caixa-manual').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'plataforma') return;
  const status = $('caixa-manual-status');
  const valor = Number($('caixa-manual-valor').value);
  if (!Number.isFinite(valor) || valor < 0) {
    status.textContent = 'informe um valor válido (≥ 0)';
    return;
  }
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'dados', 'estado'), {
      carteira_manual: { saldo_moeda: valor, atualizada_em: new Date().toISOString() },
    }, { merge: true });
    $('caixa-manual-valor').value = '';
    status.textContent = 'caixa salvo ✓ (vale no próximo ciclo do robô)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

// ------------------------------------------------------ cadastro de ativos
// Receita POR CONECTOR: identidade mínima do manifest + config inicial
// SEGURA (desligado, simulação, orçamento 0). O restante assume os padrões
// do bot (MANIFEST_PADRAO/CONFIG_ATIVO_PADRAO).
const RECEITAS_NOVO_ATIVO = {
  mb: {
    dica: 'Criptomoeda no Mercado Bitcoin: informe o código (ex.: XRP) — o par negociado será CÓDIGO-BRL.',
    montar: (id, nome, pid) => ({
      manifest: { id, nome, tipo: 'crypto', plataforma: pid, par: `${id}-BRL`, mercado24h: true },
      config: { ativo: false, modo_simulacao: true, orcamento_percentual: 0 },
    }),
  },
  tt: {
    dica: 'Ação dos EUA na Tastytrade: informe o ticker da bolsa (ex.: AAPL). Comissão é zero — sobram só centavos de taxas regulatórias na venda, capturados automaticamente da API.',
    montar: (id, nome, pid) => ({
      manifest: { id, nome, tipo: 'stock', plataforma: pid, par: id, mercado24h: false },
      config: {
        ativo: false,
        modo_simulacao: true,
        orcamento_percentual: 0,
        // Ações na Tastytrade: comissão 0; reserva conservadora de 0,02% na
        // venda para as taxas regulatórias (SEC/TAF, centavos por ordem).
        taxa_compra_percentual: 0,
        taxa_venda_percentual: 0.02,
        minimo_ordem_valor: 5, // mínimo de ordem fracionária da corretora
        minimo_ordem_quantidade: 0.0001,
      },
    }),
  },
  bn: {
    dica: 'Criptomoeda na Binance: informe o código (ex.: BTC) — o par negociado será CÓDIGOBRL (sem hífen). Taxa spot padrão 0,10%; confira a da sua conta em binance.com → Taxas.',
    montar: (id, nome, pid) => ({
      manifest: { id, nome, tipo: 'crypto', plataforma: pid, par: `${id}BRL`, mercado24h: true },
      config: {
        ativo: false,
        modo_simulacao: true,
        orcamento_percentual: 0,
        // Taxa spot padrão da Binance (0,10% maker/taker); a taxa REAL de cada
        // ordem vem dos fills da API e é registrada na operação.
        taxa_compra_percentual: 0.1,
        taxa_venda_percentual: 0.1,
        minimo_ordem_valor: 10, // NOTIONAL.minNotional dos pares BRL
        minimo_ordem_quantidade: 0.00001,
      },
    }),
  },
  toro: {
    dica: 'Ação ou FII da B3 (modo ASSISTIDO): informe o ticker (ex.: PETR4). O robô analisa em candles DIÁRIOS, a cada 6 horas, com foco em PATRIMÔNIO de longo prazo — e só RECOMENDA: você executa na Toro e registra a operação na tela do ativo.',
    montar: (id, nome, pid) => ({
      manifest: {
        id, nome, tipo: 'stock', plataforma: pid, par: id,
        mercado24h: false,
        permiteDividendos: true, // proventos da B3 somam ao lucro (via brapi)
        // A camada do SUPERVISOR semanal fica FORA (V8.16). Ele audita as
        // decisões de ENTRADA de um analista de trade, e a seção "## Geral" que
        // ele escreve vai para todo ativo: hoje ela manda vender lote no lucro
        // quando o preço perde a MM9. Numa carteira que existe para segurar
        // posição por anos isso é o oposto da tese — e como a trava de lucro
        // nasce DESLIGADA aqui, todo lote da Toro tem `trava_lucro: null` e
        // casaria com essa regra em 100% dos casos. Mesmo mecanismo das skins.
        usaSupervisao: false,
        // Swing trade em DIÁRIO: 100 candles de 1d p/ os indicadores; o
        // "volume_24h" vira o volume do último dia (1 candle de 1d).
        resolucaoAnalise: '1d',
        resolucaoContexto: '1d',
        candlesContexto: 1,
        intervaloPadrao: 60,
      },
      // Padrões de CARTEIRA DE LONGO PRAZO (V8.16). O template da plataforma diz
      // à IA para pensar em anos, mas prompt não segura o Motor: sem estes
      // números, a trava de lucro realizaria o ganho num recuo de ~1% e a
      // carteira giraria sozinha, que é o oposto do que se quer aqui.
      config: {
        ativo: false,
        // Assistida: não há ordem do robô — as operações registradas são REAIS
        // (entram no comparativo renda real × CDI).
        modo_simulacao: false,
        orcamento_percentual: 0,
        // 6 horas: o candle é DIÁRIO, então analisar de hora em hora relê o
        // mesmo dado e só gasta quota. Quatro leituras por dia já cobrem
        // abertura, meio e fim de pregão.
        tempo_entre_analises_minutos: 360,
        // O papel precisa ter andado 2% desde a última análise para valer uma
        // chamada nova de IA — em diário, menos que isso é ruído do pregão.
        percentual_minimo_variacao: 2,
        // TRAVA DE LUCRO DESLIGADA (gatilho 0). Ela é a peça certa em cripto,
        // onde realizar 1% muitas vezes é a estratégia; aqui ela venderia
        // exatamente as posições que a carteira existe para segurar.
        trava_lucro_gatilho_percentual: 0,
        trava_lucro_devolucao_percentual: 0,
        // Chão LARGO: ele existe para o caso de a tese estar errada, não para
        // reagir a oscilação de pregão. Com a folga em 8%, o trailing do Motor
        // também para de subir o chão a cada solavanco.
        stop_loss_max_distancia_percentual: 25,
        stop_loss_trailing_percentual: 8,
        // Corretagem zero na Toro; sobram emolumentos/liquidação da B3 (~0,03%).
        taxa_compra_percentual: 0.03,
        taxa_venda_percentual: 0.03,
        minimo_ordem_valor: 10,
        minimo_ordem_quantidade: 1, // ações inteiras (mercado fracionário: 1 ação)
      },
    }),
  },
};

$('form-novo-ativo').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'plataforma') return;
  const status = $('novo-ativo-status');
  const p = plataformas.get(rota.plataforma);
  const receita = RECEITAS_NOVO_ATIVO[p?.dados?.conector];
  if (!receita) {
    status.textContent = 'esta plataforma não tem receita de cadastro — cadastre pelo Firestore';
    return;
  }

  const id = $('novo-ativo-codigo').value.trim().toUpperCase();
  const nome = $('novo-ativo-nome').value.trim();
  if (!/^[A-Z0-9.]{1,12}$/.test(id)) {
    status.textContent = 'código inválido — use letras/números (ex.: AAPL, BTC)';
    return;
  }
  if (p?.ativos?.has(id)) {
    status.textContent = `${id} já está cadastrado nesta plataforma`;
    return;
  }

  status.textContent = 'cadastrando…';
  try {
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'ativos', id), receita.montar(id, nome, rota.plataforma));
    avisarConfigMudou();
    $('novo-ativo-codigo').value = '';
    $('novo-ativo-nome').value = '';
    status.textContent = `${id} cadastrado ✓ — desligado e com orçamento 0%; configure e ligue na tela dele (menu ao lado)`;
  } catch (e) {
    status.textContent = `erro ao cadastrar: ${e.code ?? e.message}`;
  }
});

let templateEditando = false;
$('texto-template').addEventListener('focus', () => { templateEditando = true; });
$('texto-template').addEventListener('blur', () => { templateEditando = false; });
function renderTemplate() {
  $('template-versao').textContent = telaDados.template?.versao ? `(versão ${telaDados.template.versao})` : '';
  if (!templateEditando) $('texto-template').value = telaDados.template?.conteudo ?? '';
}

$('form-plataforma').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'plataforma') return;
  const status = $('plataforma-status');
  status.textContent = 'salvando…';

  const modelos = $('cfg-modelos-ia').value.split(',').map((m) => m.trim()).filter(Boolean);
  const api = {};
  const chaveIA = $('cfg-api-key-ia').value.trim();
  if (chaveIA) api.api_key_ia = chaveIA; // campo vazio = manter a atual
  $('cfg-api-key-ia').value = '';
  for (const input of $('campos-api-corretora').querySelectorAll('input')) {
    const valor = input.value.trim();
    if (valor) api[input.dataset.campo] = valor;
    input.value = '';
  }

  try {
    if (modelos.length > 0) {
      await setDoc(doc(db, 'plataformas', rota.plataforma), { modelos_ia: modelos }, { merge: true });
    }
    if (Object.keys(api).length > 0) {
      await setDoc(doc(db, 'plataformas', rota.plataforma, 'dados', 'api'), api, { merge: true });
    }
    avisarConfigMudou();
    status.textContent = 'plataforma salva ✓ (vale no próximo ciclo do bot)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

// ------------------------------------------- Steam: skins do CS2 (assistida)
// Tela própria porque o que importa aqui é o INVENTÁRIO com foto e o check por
// item — nada a ver com a tela de plataforma (chaves de corretora, pregão).
// Tudo que aparece vem do Firestore: o navegador não consegue falar com a
// Steam (sem CORS), quem lê é o bot.

const STEAM_INTERVALOS_PADRAO = { analise_minutos: 60, precos_minutos: 60, noticias_minutos: 30 };
const STEAM_INTERVALO_MINIMO = 15;

/** O item está sendo analisado? A verdade é o ATIVO existir e estar ligado. */
function steamItemAnalisado(id) {
  const ativo = plataformas.get(PLATAFORMA_STEAM)?.ativos.get(id);
  return Boolean(ativo) && ativo.config?.ativo !== false;
}

// ------------------------------------------ pausar as análises da Steam (V8.16)
// Um campo só no doc da plataforma (`analises_pausadas`), que o orquestrador lê
// pelo catálogo. Pausa o ANALISTA — que é o que gasta uma chamada de IA por item
// marcado, a cada rodada — e não o resto: preços do inventário, atualizações do
// CS2 e alertas de preço-alvo continuam. O campo é genérico de propósito: o
// núcleo não conhece "STEAM", e qualquer plataforma pode ser pausada assim.
function renderSteamPausa() {
  const botao = $('btn-steam-pausar');
  if (!botao) return;
  const pausada = plataformas.get(PLATAFORMA_STEAM)?.dados?.analises_pausadas === true;
  botao.textContent = pausada ? '▶ Retomar análises da Steam' : '⏸ Pausar análises da Steam';
  botao.className = pausada ? 'botao-primario' : 'botao-perigo';
  $('steam-pausa-status').textContent = pausada
    ? '⏸ análises PAUSADAS — nenhuma chamada de IA nesta plataforma'
    : '';
}

aoEvento('btn-steam-pausar', 'click', async () => {
  const status = $('steam-pausa-status');
  const pausada = plataformas.get(PLATAFORMA_STEAM)?.dados?.analises_pausadas === true;
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'plataformas', PLATAFORMA_STEAM), { analises_pausadas: !pausada }, { merge: true });
    avisarConfigMudou();
    status.textContent = pausada
      ? 'análises retomadas ✓ — a próxima rodada volta a analisar os itens marcados'
      : 'análises pausadas ✓ — vale no próximo minuto; preços e notícias continuam';
  } catch (e) {
    status.textContent = `erro: ${e.code ?? e.message}`;
  }
});

function renderSteam() {
  if (!$('tela-steam')) return; // HTML antigo em cache: degrada em vez de derrubar
  renderSteamPausa();
  const inv = telaDados.inventario ?? {};
  const itens = Array.isArray(inv.itens) ? inv.itens : [];
  const comPreco = itens.filter((i) => Number.isFinite(i.valor_total));
  const total = comPreco.reduce((s, i) => s + i.valor_total, 0);
  const marcados = itens.filter((i) => steamItemAnalisado(i.id)).length;

  $('steam-qtd').textContent = itens.length === 0 ? '—' : `${itens.length}`;
  // O total soma só o que tem preço; dizer quantos ficaram de fora evita o
  // dono achar que o inventário inteiro vale isso.
  $('steam-total').textContent = itens.length === 0
    ? '—'
    : `${fmtMoeda('BRL').cheio.format(total)}${comPreco.length < itens.length ? ` (${itens.length - comPreco.length} sem preço)` : ''}`;
  $('steam-marcados').textContent = itens.length === 0 ? '—' : `${marcados}`;
  $('steam-atualizado').textContent = inv.atualizado_em
    ? new Date(inv.atualizado_em).toLocaleString('pt-BR')
    : 'ainda não — o bot monta o retrato no próximo ciclo';

  const erro = $('steam-erro');
  erro.hidden = !inv.erro;
  erro.textContent = inv.erro ? `⚠ última tentativa falhou: ${inv.erro}` : '';

  const grade = $('steam-itens');
  grade.textContent = '';
  if (itens.length === 0) {
    const p = document.createElement('p');
    p.className = 'texto-secundario';
    p.textContent = 'Nenhum item ainda. Confira o SteamID64 abaixo e se o inventário está público.';
    grade.append(p);
    return;
  }

  for (const item of itens) {
    const cartao = document.createElement('article');
    cartao.className = 'steam-item';

    if (item.imagem) {
      const img = document.createElement('img');
      img.src = item.imagem;
      img.alt = '';
      img.loading = 'lazy';
      cartao.append(img);
    }

    const nome = document.createElement('p');
    nome.className = 'steam-item-nome';
    // textContent: nome de item vem de fora e nunca vira HTML (anti-XSS).
    nome.textContent = item.market_hash_name;
    nome.title = item.market_hash_name;
    cartao.append(nome);

    const linha = document.createElement('p');
    linha.className = 'texto-secundario';
    const preco = Number.isFinite(item.preco) ? fmtMoeda('BRL').cheio.format(item.preco) : '—';
    linha.textContent = item.quantidade > 1
      ? `${item.quantidade}× ${preco} = ${Number.isFinite(item.valor_total) ? fmtMoeda('BRL').cheio.format(item.valor_total) : '—'}`
      : preco;
    cartao.append(linha);

    if (!item.negociavel) {
      const aviso = document.createElement('p');
      aviso.className = 'texto-secundario';
      aviso.textContent = 'não vendável no mercado';
      cartao.append(aviso);
    }

    const rotulo = document.createElement('label');
    rotulo.className = 'alternador';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = steamItemAnalisado(item.id);
    check.disabled = !item.negociavel; // sem preço não há o que analisar
    check.addEventListener('change', () => marcarItemSteam(item, check));
    const texto = document.createElement('span');
    texto.textContent = 'analisar com IA';
    rotulo.append(check, texto);
    cartao.append(rotulo);

    // Item marcado tem tela própria (a mesma de qualquer ativo): é lá que ficam
    // a recomendação da IA, as posições e o formulário para você registrar a
    // compra ou a venda que fez na Steam.
    if (steamItemAnalisado(item.id)) {
      const link = document.createElement('a');
      link.href = `#/ativo/${PLATAFORMA_STEAM}/${item.id}`;
      link.className = 'texto-secundario';
      link.textContent = 'ver análise e registrar operação →';
      cartao.append(link);
    }

    grade.append(cartao);
  }
}

/**
 * Marcar CRIA o ativo (ou o religa); desmarcar apenas o desliga — nunca apaga,
 * porque o histórico do item é dele. Mesmo caminho do "cadastrar ativo" das
 * outras plataformas, só que disparado por um check.
 */
async function marcarItemSteam(item, check) {
  const status = $('steam-status');
  const ligar = check.checked;
  check.disabled = true;
  status.textContent = ligar ? 'ligando análise…' : 'desligando…';
  const intervalos = steamIntervalos();
  try {
    const ref = doc(db, 'plataformas', PLATAFORMA_STEAM, 'ativos', item.id);
    if (ligar) {
      await setDoc(ref, {
        manifest: {
          id: item.id,
          nome: item.nome || item.market_hash_name,
          tipo: 'skin',
          plataforma: PLATAFORMA_STEAM,
          par: item.market_hash_name, // o nome EXATO — é o que a API entende
          mercado24h: true, // o mercado da Steam não fecha
          usaSupervisao: false, // o supervisor audita ativo financeiro, não skin
          // Este mercado não tem candle: sem histórico não há RSI, MACD nem
          // média móvel. O ciclo pula os indicadores e passa a guardar o preço
          // a cada coleta, montando a série própria do item.
          usaIndicadores: false,
          usaNoticias: true, // as notas de atualização do CS2 entram no prompt
          intervaloPadrao: intervalos.analise_minutos,
        },
        config: {
          ativo: true,
          // Assistida: as operações que você registrar são REAIS.
          modo_simulacao: false,
          orcamento_percentual: 0,
          tempo_entre_analises_minutos: intervalos.analise_minutos,
          // A Steam cobra ~15% na venda, e nada na compra: o comprador paga X e
          // o vendedor recebe X ÷ 1,15. Em percentual do valor bruto da venda
          // isso é 13,04% — e faz o preço mínimo de venda lucrativa ser
          // exatamente compra × 1,15.
          taxa_compra_percentual: 0,
          taxa_venda_percentual: 13.04,
          minimo_ordem_valor: 0.03, // menor preço que o mercado da Steam aceita
          minimo_ordem_quantidade: 1, // itens são inteiros
        },
      }, { merge: true });
    } else {
      await setDoc(ref, { config: { ativo: false } }, { merge: true });
    }
    avisarConfigMudou();
    status.textContent = ligar
      ? `${item.market_hash_name} entrou na análise ✓`
      : `${item.market_hash_name} saiu da análise (o histórico dele fica)`;
  } catch (e) {
    check.checked = !ligar;
    status.textContent = `erro: ${e.code ?? e.message}`;
  } finally {
    check.disabled = !item.negociavel;
  }
}

/** Os três intervalos como estão na tela, com o piso aplicado. */
function steamIntervalos() {
  const ler = (id, padrao) => {
    const n = Number($(id).value);
    return !Number.isFinite(n) || n <= 0 ? padrao : Math.max(STEAM_INTERVALO_MINIMO, Math.round(n));
  };
  return {
    analise_minutos: ler('steam-int-analise', STEAM_INTERVALOS_PADRAO.analise_minutos),
    precos_minutos: ler('steam-int-precos', STEAM_INTERVALOS_PADRAO.precos_minutos),
    noticias_minutos: ler('steam-int-noticias', STEAM_INTERVALOS_PADRAO.noticias_minutos),
  };
}

let steamConfigEditando = false;
for (const id of ['steam-id64', 'steam-int-analise', 'steam-int-precos', 'steam-int-noticias']) {
  aoEvento(id, 'focus', () => { steamConfigEditando = true; });
  aoEvento(id, 'blur', () => { steamConfigEditando = false; });
}

function renderSteamConfig() {
  if (!$('tela-steam')) return; // HTML antigo em cache: degrada em vez de derrubar
  if (steamConfigEditando) return; // não sobrescrever o que o dono está digitando
  const p = plataformas.get(PLATAFORMA_STEAM)?.dados ?? {};
  const i = { ...STEAM_INTERVALOS_PADRAO, ...(p.intervalos ?? {}) };
  $('steam-id64').value = p.steam_id64 ?? '';
  $('steam-int-analise').value = i.analise_minutos;
  $('steam-int-precos').value = i.precos_minutos;
  $('steam-int-noticias').value = i.noticias_minutos;
}

aoEvento('form-steam-config', 'submit', async (ev) => {
  ev.preventDefault();
  const status = $('steam-config-status');
  const id64 = $('steam-id64').value.trim();
  if (id64 && !/^\d{17}$/.test(id64)) {
    status.textContent = 'SteamID64 são 17 dígitos — o número que aparece na URL do seu perfil';
    return;
  }
  status.textContent = 'salvando…';
  try {
    await setDoc(
      doc(db, 'plataformas', PLATAFORMA_STEAM),
      { steam_id64: id64, intervalos: steamIntervalos() },
      { merge: true },
    );
    avisarConfigMudou();
    steamConfigEditando = false;
    status.textContent = 'configuração salva ✓ (o bot passa a usar no próximo minuto)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

// "Atualizar agora": grava uma MARCA no doc que o bot já lê a cada minuto
// (global/controle), a mesma carona do "rodar supervisão agora". Nenhuma
// leitura nova no tick, e o bot atende no próximo minuto.
aoEvento('btn-steam-atualizar', 'click', async () => {
  const status = $('steam-status');
  status.textContent = 'pedindo ao bot…';
  try {
    await setDoc(doc(db, 'global', 'controle'), { inventario_solicitado_em: new Date().toISOString() }, { merge: true });
    status.textContent = 'pedido enviado ✓ — o inventário é relido no próximo minuto (varrer os preços leva alguns)';
  } catch (e) {
    status.textContent = `erro: ${e.code ?? e.message}`;
  }
});

/**
 * Alertas de preço-alvo. A dashboard escreve os ALVOS (campo `itens`); o bot
 * escreve só o estado das travessias já avisadas (campo `estado`) — campos
 * separados de propósito, para um nunca apagar o outro no merge.
 */
function renderSteamAlertas() {
  if (!$('tela-steam')) return; // HTML antigo em cache: degrada em vez de derrubar
  const itens = Array.isArray(telaDados.inventario?.itens) ? telaDados.inventario.itens : [];
  const alvos = telaDados.alertas?.itens ?? {};

  // O seletor lista todos os itens do inventário, marcados ou não: alerta não
  // custa análise, então não faz sentido restringi-lo aos analisados.
  const sel = $('steam-alerta-item');
  const escolhido = sel.value;
  sel.textContent = '';
  for (const item of itens) {
    const op = document.createElement('option');
    op.value = item.id;
    op.textContent = item.market_hash_name;
    sel.append(op);
  }
  if (escolhido) sel.value = escolhido;

  const lista = $('steam-alertas-ativos');
  lista.textContent = '';
  const ativos = Object.entries(alvos).filter(([, a]) => Number(a?.abaixo) > 0 || Number(a?.acima) > 0);
  if (ativos.length === 0) return;

  const tabela = document.createElement('table');
  tabela.className = 'tabela';
  const cab = tabela.insertRow();
  for (const t of ['Item', 'Abaixo de', 'Acima de', 'Preço agora', '']) {
    const th = document.createElement('th');
    th.textContent = t;
    cab.append(th);
  }
  for (const [id, alvo] of ativos) {
    const item = itens.find((i) => i.id === id);
    const linha = tabela.insertRow();
    linha.insertCell().textContent = item?.market_hash_name ?? id;
    linha.insertCell().textContent = Number(alvo.abaixo) > 0 ? dinheiro(Number(alvo.abaixo), 'BRLS') : '—';
    linha.insertCell().textContent = Number(alvo.acima) > 0 ? dinheiro(Number(alvo.acima), 'BRLS') : '—';
    linha.insertCell().textContent = Number.isFinite(item?.preco) ? dinheiro(item.preco, 'BRLS') : '—';
    const acao = linha.insertCell();
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'botao-fantasma';
    botao.textContent = 'remover';
    botao.addEventListener('click', () => salvarAlertaSteam(id, null, null));
    acao.append(botao);
  }
  lista.append(tabela);
}

async function salvarAlertaSteam(id, abaixo, acima) {
  const status = $('steam-alerta-status');
  status.textContent = 'salvando…';
  try {
    // Alvo vazio grava `null` em vez de apagar a chave: o Firestore não remove
    // campo de mapa num merge, e `null` é o que o bot lê como "sem alvo".
    await setDoc(
      doc(db, 'plataformas', PLATAFORMA_STEAM, 'dados', 'alertas'),
      { itens: { [id]: { abaixo: abaixo ?? null, acima: acima ?? null } } },
      { merge: true },
    );
    status.textContent = abaixo || acima ? 'alerta salvo ✓' : 'alerta removido ✓';
  } catch (e) {
    status.textContent = `erro: ${e.code ?? e.message}`;
  }
}

aoEvento('form-steam-alerta', 'submit', async (ev) => {
  ev.preventDefault();
  const id = $('steam-alerta-item').value;
  if (!id) {
    $('steam-alerta-status').textContent = 'escolha um item';
    return;
  }
  const abaixo = Number($('steam-alerta-abaixo').value) || null;
  const acima = Number($('steam-alerta-acima').value) || null;
  if (!abaixo && !acima) {
    $('steam-alerta-status').textContent = 'preencha ao menos um dos dois preços';
    return;
  }
  await salvarAlertaSteam(id, abaixo, acima);
  $('steam-alerta-abaixo').value = '';
  $('steam-alerta-acima').value = '';
});

/**
 * Últimas atualizações do CS2. Só desenha o que o bot já guardou — a Steam não
 * é consultada pelo navegador em nenhum momento.
 */
function renderSteamNoticias() {
  if (!$('tela-steam')) return; // HTML antigo em cache: degrada em vez de derrubar
  const alvo = $('steam-noticias');
  alvo.textContent = '';
  const itens = Array.isArray(telaDados.noticias?.itens) ? telaDados.noticias.itens : [];
  if (itens.length === 0) {
    const p = document.createElement('p');
    p.className = 'texto-secundario';
    p.textContent = 'Nenhuma ainda — o robô procura no intervalo configurado acima.';
    alvo.append(p);
    return;
  }

  for (const n of itens.slice(0, 5)) {
    const item = document.createElement('details');
    item.className = 'steam-noticia';

    const resumo = document.createElement('summary');
    const quando = n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '';
    // textContent sempre: o texto vem da Valve e nunca vira HTML (anti-XSS).
    resumo.textContent = quando ? `${quando} — ${n.titulo}` : n.titulo;
    item.append(resumo);

    const corpo = document.createElement('p');
    corpo.className = 'texto-secundario';
    corpo.style.whiteSpace = 'pre-wrap';
    corpo.textContent = n.conteudo || '(sem texto)';
    item.append(corpo);

    if (n.url) {
      const link = document.createElement('a');
      link.href = n.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'abrir na Steam';
      item.append(link);
    }
    alvo.append(item);
  }
}

let steamPromptEditando = false;
aoEvento('texto-steam-prompt', 'focus', () => { steamPromptEditando = true; });
aoEvento('texto-steam-prompt', 'blur', () => { steamPromptEditando = false; });

function renderSteamPrompt() {
  if (!$('tela-steam')) return; // HTML antigo em cache: degrada em vez de derrubar
  $('steam-prompt-versao').textContent = telaDados.steamPrompt?.versao ? `(versão ${telaDados.steamPrompt.versao})` : '';
  if (!steamPromptEditando) $('texto-steam-prompt').value = telaDados.steamPrompt?.conteudo ?? '';
}

aoEvento('form-steam-prompt', 'submit', async (ev) => {
  ev.preventDefault();
  const status = $('steam-prompt-status');
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'plataformas', PLATAFORMA_STEAM, 'dados', 'template'), {
      conteudo: $('texto-steam-prompt').value,
      versao: (telaDados.steamPrompt?.versao ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    });
    avisarConfigMudou();
    steamPromptEditando = false;
    status.textContent = 'prompt salvo ✓';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

// -------------------------------------------------- regras gerais (globais)
let regrasEditando = false;
$('texto-regras').addEventListener('focus', () => { regrasEditando = true; });
$('texto-regras').addEventListener('blur', () => { regrasEditando = false; });
let regrasVendaEditando = false;
$('texto-regras-venda').addEventListener('focus', () => { regrasVendaEditando = true; });
$('texto-regras-venda').addEventListener('blur', () => { regrasVendaEditando = false; });
function renderRegras() {
  $('regras-versao').textContent = telaDados.regras?.versao ? `(versão ${telaDados.regras.versao})` : '';
  if (!regrasEditando) $('texto-regras').value = telaDados.regras?.conteudo ?? '';
  $('regras-venda-versao').textContent = telaDados.regrasVenda?.versao ? `(versão ${telaDados.regrasVenda.versao})` : '';
  if (!regrasVendaEditando) $('texto-regras-venda').value = telaDados.regrasVenda?.conteudo ?? '';
}
$('form-regras').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = $('regras-status');
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'global', 'regras_gerais'), {
      conteudo: $('texto-regras').value,
      versao: (telaDados.regras?.versao ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    });
    avisarConfigMudou();
    status.textContent = 'regras salvas ✓ (valem para todos os ativos no próximo ciclo)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

$('form-regras-venda').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = $('regras-venda-status');
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'global', 'regras_gerais_venda'), {
      conteudo: $('texto-regras-venda').value,
      versao: (telaDados.regrasVenda?.versao ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    });
    avisarConfigMudou();
    status.textContent = 'regras de liquidação salvas ✓ (valem quando o modo vendas estiver ligado)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

// ------------------------------------------- supervisão semanal (V7.2)
// A camada de prompt que o agente supervisor escreve. A tela existe para o dono
// poder VER o que outra IA escreveu no prompt do analista, editar, desligar e
// voltar atrás — automação sem janela de inspeção seria caixa-preta.

let supervisaoEditando = false;
let supPromptEditando = false;
$('texto-supervisao').addEventListener('focus', () => { supervisaoEditando = true; });
$('texto-supervisao').addEventListener('blur', () => { supervisaoEditando = false; });
$('texto-sup-prompt').addEventListener('focus', () => { supPromptEditando = true; });
$('texto-sup-prompt').addEventListener('blur', () => { supPromptEditando = false; });

function renderSupervisao() {
  const s = telaDados.supervisao ?? null;
  const cfg = telaDados.supervisorConfig ?? null;

  // O doc mistura duas coisas de ciclos de vida diferentes: a CAMADA em vigor
  // (conteudo/versao/origem) e a RODADA que a gerou (diagnostico/mudancas/
  // palpites/modelo/confianca). Editar a camada à mão avança só a primeira — daí
  // a tela precisar dizer qual é qual, em vez de exibir tudo lado a lado como se
  // descrevesse o mesmo texto.
  const rodada = s?.versao_rodada ?? null;
  $('sup-gerado').textContent = s?.gerado_em
    ? `${dataHora(s.gerado_em)}${rodada ? ` · gerou a v${rodada}` : ''}`
    : 'nunca executada';
  $('sup-versao').textContent = s?.versao ? `v${s.versao}${s.origem === 'dono' ? ' (editada por você)' : ''}` : '—';
  $('sup-modelo').textContent = s?.modelo ?? '—';
  $('sup-confianca').textContent = Number.isFinite(s?.confianca) ? `${s.confianca}%` : '—';
  $('sup-origem').textContent = s?.atualizado_em ? `Atualizada em ${dataHora(s.atualizado_em)}.` : '';
  $('sup-ativo').checked = cfg?.ativo !== false;

  // A camada em vigor não é mais a que esta rodada escreveu. `versao_rodada` só
  // existe em docs gravados a partir da V7.3; sem ele, `origem: 'dono'` já é o
  // sinal de que o texto atual foi escrito à mão depois da rodada.
  const defasada = Boolean(s?.conteudo) && (rodada ? rodada !== s.versao : s?.origem === 'dono');
  const aviso = $('sup-defasada');
  aviso.hidden = !defasada;
  aviso.textContent = defasada
    ? `Você editou a camada depois desta rodada${s.atualizado_em ? ` (em ${dataHora(s.atualizado_em)})` : ''}: `
      + `o que está abaixo descreve a v${rodada ?? '1'} escrita pela IA, não a v${s.versao} que está valendo. `
      + 'A próxima rodada reescreve os dois.'
    : '';

  $('sup-diagnostico').textContent = s?.diagnostico ?? 'Nenhuma supervisão executada ainda.';

  const mudancas = $('sup-mudancas');
  mudancas.textContent = '';
  for (const m of s?.mudancas ?? []) {
    const li = document.createElement('li');
    li.textContent = m; // textContent: texto vindo de IA nunca entra como HTML
    mudancas.append(li);
  }

  const palpites = $('sup-palpites');
  palpites.textContent = '';
  for (const p of s?.palpites ?? []) {
    const li = document.createElement('li');
    const onde = [p.plataforma, p.ativo].filter(Boolean).join('/');
    if (onde) {
      const forte = document.createElement('strong');
      forte.textContent = `${onde}: `;
      li.append(forte);
    }
    li.append(document.createTextNode(p.observacao ?? ''));
    palpites.append(li);
  }

  if (!supervisaoEditando) $('texto-supervisao').value = s?.conteudo ?? '';

  const hist = $('sup-historico');
  hist.textContent = '';
  const versoes = s?.historico ?? [];
  if (!versoes.length) {
    hist.textContent = 'Nenhuma versão anterior guardada.';
    hist.className = 'texto-secundario';
  } else {
    hist.className = '';
    for (const v of versoes) {
      const bloco = document.createElement('details');
      bloco.className = 'sup-versao';
      const titulo = document.createElement('summary');
      titulo.textContent = `v${v.versao} · ${v.atualizado_em ? dataHora(v.atualizado_em) : 'sem data'}`;
      const corpo = document.createElement('pre');
      corpo.textContent = v.conteudo ?? '';
      const restaurar = document.createElement('button');
      restaurar.type = 'button';
      restaurar.className = 'botao-fantasma';
      restaurar.textContent = 'Restaurar esta versão';
      restaurar.addEventListener('click', () => {
        $('texto-supervisao').value = v.conteudo ?? '';
        $('sup-status').textContent = 'versão carregada no editor — clique em "Salvar camada" para aplicar';
        $('texto-supervisao').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      bloco.append(titulo, corpo, restaurar);
      hist.append(bloco);
    }
  }
}

function renderSupPrompt() {
  const p = telaDados.supervisorPrompt ?? null;
  $('sup-prompt-versao').textContent = p?.versao ? `(versão ${p.versao})` : '';
  if (!supPromptEditando) $('texto-sup-prompt').value = p?.conteudo ?? '';
}

// Liga/desliga o envio da camada ao analista (kill-switch).
$('sup-ativo').addEventListener('change', async (ev) => {
  const status = $('sup-acao-status');
  try {
    await setDoc(
      doc(db, 'global', 'supervisor'),
      { ativo: ev.target.checked, atualizado_em: new Date().toISOString(), origem: 'dashboard' },
      { merge: true },
    );
    avisarConfigMudou();
    status.textContent = ev.target.checked
      ? 'camada ligada ✓ (volta ao prompt do analista no próximo ciclo)'
      : 'camada desligada ✓ (o analista para de recebê-la no próximo ciclo)';
  } catch (e) {
    status.textContent = `erro: ${e.code ?? e.message}`;
  }
});

// "Rodar agora": grava o pedido em `global/controle`, que o bot já lê a cada
// tick — o botão não fala com a IA, quem roda é sempre o bot.
$('btn-sup-rodar').addEventListener('click', async () => {
  if (!confirm('Rodar a supervisão agora?\n\nO agente vai analisar a última semana e pode reescrever a camada de prompt do analista.')) return;
  const status = $('sup-acao-status');
  status.textContent = 'pedido enviado — o bot roda no próximo minuto…';
  try {
    await setDoc(
      doc(db, 'global', 'controle'),
      { supervisao_solicitada: true, supervisao_solicitada_em: new Date().toISOString(), origem: 'dashboard' },
      { merge: true },
    );
  } catch (e) {
    status.textContent = `erro ao pedir: ${e.code ?? e.message}`;
  }
});

$('form-supervisao').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = $('sup-status');
  status.textContent = 'salvando…';
  try {
    const atual = telaDados.supervisao ?? {};
    const anterior = atual.conteudo
      ? [{ versao: atual.versao ?? 0, conteudo: atual.conteudo, atualizado_em: atual.atualizado_em ?? null, diagnostico: atual.diagnostico ?? null }]
      : [];
    // De propósito, o `merge` abaixo NÃO toca nos campos da RODADA
    // (diagnostico/mudancas/palpites/modelo/confianca/versao_rodada): eles
    // continuam descrevendo o que a IA fez, e apagá-los perderia o histórico da
    // auditoria. Quem avisa que eles já não descrevem a camada em vigor é a
    // tela, comparando `versao_rodada` com `versao` (ver renderSupervisao).
    await setDoc(
      doc(db, 'global', 'supervisao'),
      {
        conteudo: $('texto-supervisao').value,
        versao: (atual.versao ?? 0) + 1,
        atualizado_em: new Date().toISOString(),
        origem: 'dono',
        historico: [...anterior, ...(atual.historico ?? [])].slice(0, 5),
      },
      { merge: true },
    );
    avisarConfigMudou();
    status.textContent = 'camada salva ✓ (vale no próximo ciclo)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

$('form-sup-prompt').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = $('sup-prompt-status');
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'global', 'supervisor_prompt'), {
      conteudo: $('texto-sup-prompt').value,
      versao: (telaDados.supervisorPrompt?.versao ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    });
    status.textContent = 'instruções salvas ✓ (valem na próxima rodada semanal)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});

$('form-template').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (rota.tipo !== 'plataforma') return;
  const status = $('template-status');
  status.textContent = 'salvando…';
  try {
    await setDoc(doc(db, 'plataformas', rota.plataforma, 'dados', 'template'), {
      conteudo: $('texto-template').value,
      versao: (telaDados.template?.versao ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    });
    avisarConfigMudou();
    status.textContent = 'template salvo ✓ (vale para todos os ativos no próximo ciclo)';
  } catch (e) {
    status.textContent = `erro ao salvar: ${e.code ?? e.message}`;
  }
});
