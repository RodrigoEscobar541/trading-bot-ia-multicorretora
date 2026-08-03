// segredos.test.js — os segredos fora do alcance do navegador (2026-07-25).
//
// As RULES são testadas contra o emulador (tests/rules/, `npm run test:rules`).
// Aqui fica o lado do bot: o espelho mascarado que substitui a leitura das
// chaves e a migração do token do Telegram para o doc protegido.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  inicializarPersistencia,
  mascararApi,
  obterTelegram,
  salvarTelegram,
  salvarTelegramToken,
  migrarTokenTelegram,
} from '../src/firebase/firebaseClient.js';

beforeEach(async () => {
  await inicializarPersistencia({ modo: 'memoria' }); // backend novo a cada teste
});

// ------------------------------------------------------- espelho mascarado

test('o espelho guarda só os 4 últimos caracteres — nunca a chave', () => {
  const meta = mascararApi({
    api_key_ia: 'AIzaSyQualquerCoisaSecreta1234',
    mb_api_token_secret: 'abcdefghijklmnop',
  });
  assert.equal(meta.api_key_ia, '…1234');
  assert.equal(meta.mb_api_token_secret, '…mnop');
  // A garantia que interessa: o segredo inteiro não está em lugar nenhum.
  const serializado = JSON.stringify(meta);
  assert.doesNotMatch(serializado, /AIzaSyQualquerCoisaSecreta/);
  assert.doesNotMatch(serializado, /abcdefghijkl/);
});

test('campo vazio, nulo ou não-string vira null (a tela mostra "não configurada")', () => {
  const meta = mascararApi({ a: '', b: null, c: undefined, d: 42, e: '   ' });
  assert.deepEqual(meta, { a: null, b: null, c: null, d: null, e: null });
});

test('mascarar um doc vazio não quebra', () => {
  assert.deepEqual(mascararApi({}), {});
  assert.deepEqual(mascararApi(null), {});
});

// ------------------------------------------------ token do Telegram movido

test('obterTelegram junta a config legível com o token protegido', async () => {
  await salvarTelegram({ chat_id: '123', ativo: true });
  await salvarTelegramToken('tok-secreto');
  const cfg = await obterTelegram();
  assert.equal(cfg.chat_id, '123');
  assert.equal(cfg.bot_token, 'tok-secreto');
});

test('migração tira o token do doc LEGÍVEL e o põe no protegido', async () => {
  // Estado anterior às rules: token no doc que o navegador lia.
  await salvarTelegram({ chat_id: '123', ativo: true, bot_token: 'tok-antigo' });

  const r = await migrarTokenTelegram();
  assert.equal(r.migrado, true);

  const cfg = await obterTelegram();
  // O bot continua enxergando o token (vem do doc protegido)...
  assert.equal(cfg.bot_token, 'tok-antigo');
  // ...e a tela sabe que existe um configurado, sem receber o valor.
  assert.equal(cfg.token_configurado, true);
});

test('migração é idempotente e não roda quando não há o que mover', async () => {
  await salvarTelegram({ chat_id: '123' });
  assert.equal((await migrarTokenTelegram()).migrado, false);

  await salvarTelegram({ bot_token: 'tok' });
  assert.equal((await migrarTokenTelegram()).migrado, true);
  assert.equal((await migrarTokenTelegram()).migrado, false); // já moveu
  assert.equal((await obterTelegram()).bot_token, 'tok');
});

test('sem nenhuma configuração, obterTelegram devolve null', async () => {
  assert.equal(await obterTelegram(), null);
});
