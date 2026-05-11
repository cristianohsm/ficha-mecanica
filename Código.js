// ===== CONFIG =====
const DEFAULT_SPREADSHEET_ID = '10u4arnqwIH4_W-pwMrYBT6FunZopw0eLj2gl_MfE1QA';
const SHEET_FICHAS = 'FICHAS';
const SHEET_CAD = 'CADASTROS';

const CTRL_COLS = ['Status', 'UltimoErro', 'PDF_URL', 'EnviadoEm', 'SubmitKey'];
const APP_VERSION = 'v2.5-tony-infocar-operacional';
const DEFAULT_PROD_SCRIPT_ID = '1MPvCAkwSsVeauToomA18zwVLC2iINk-GdQQ9_YN3_j2JHT2tdnoZKa7R';
const DEFAULT_TEST_EMAIL_TO = 'cristianotonyveiculos@gmail.com';

// IDs
const DEFAULT_PDF_FOLDER_ID = '1YPyBpBWjKDBH_sl-Q4KTYp6sOKfnE1a_';
const DEFAULT_DOC_TEMPLATE_ID = '1ZTzPhHyEI7dFpgb5yOIFJ190bRr1FJS6moOpjX9eMLI';

// Script Properties
const PROP_APP_ENV = 'APP_ENV';
const PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
const PROP_PDF_FOLDER_ID = 'PDF_FOLDER_ID';
const PROP_DOC_TEMPLATE_ID = 'DOC_TEMPLATE_ID';
const PROP_TEST_EMAIL_TO = 'TEST_EMAIL_TO';
const PROP_ADMIN_PASSWORD = 'ADMIN_CONFIG_PASSWORD';
const PROP_EMAIL_SETTINGS = 'EMAIL_ROUTING_SETTINGS';

function getAppConfig_() {
  const props = PropertiesService.getScriptProperties();
  const env = String(props.getProperty(PROP_APP_ENV) || 'PROD').trim().toUpperCase();
  return {
    env,
    isLab: env !== 'PROD',
    spreadsheetId: String(props.getProperty(PROP_SPREADSHEET_ID) || DEFAULT_SPREADSHEET_ID).trim(),
    pdfFolderId: String(props.getProperty(PROP_PDF_FOLDER_ID) || DEFAULT_PDF_FOLDER_ID).trim(),
    docTemplateId: String(props.getProperty(PROP_DOC_TEMPLATE_ID) || DEFAULT_DOC_TEMPLATE_ID).trim(),
    testEmailTo: String(props.getProperty(PROP_TEST_EMAIL_TO) || DEFAULT_TEST_EMAIL_TO).trim()
  };
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(getAppConfig_().spreadsheetId);
}

function getCurrentScriptId_() {
  try {
    return ScriptApp.getScriptId();
  } catch (e) {
    return '';
  }
}

// ===== CACHE =====
const CATALOGS_CACHE_KEY = 'FM_CATALOGS_V1';
const CATALOGS_CACHE_TTL_SECONDS = 21600; // 6 horas

// ===== CONSULTA POR PLACA - TONY / INFOCAR =====
const TONY_INFOCAR_API_URL = 'https://api.tonyveiculos.com.br/api/integracao_infocar_tony/consulta_dados_enriquecidos';
const TONY_INFOCAR_PLACA_CACHE_TTL_SECONDS = 21600; // 6 horas
const TONY_INFOCAR_MAX_TENTATIVAS = 3;

// ===== PRECIFICADOR =====
const PRECIF_BASE_URL = 'https://api.tonyveiculos.com.br';
const PRECIF_API_TOKEN = ''; // se precisar token, preencher aqui
const PRECIF_CACHE_TTL_SECONDS = 21600; // 6 horas

function getPrecifHeaders_() {
  const headers = { 'Accept': 'application/json' };
  if (PRECIF_API_TOKEN && String(PRECIF_API_TOKEN).trim()) {
    headers['Authorization'] = 'Token ' + PRECIF_API_TOKEN;
  }
  return headers;
}

function requestPrecif_(method, endpoint, payload, bodyMode) {
  const url = PRECIF_BASE_URL + endpoint;
  const options = {
    method: method || 'get',
    muteHttpExceptions: true,
    headers: getPrecifHeaders_()
  };

  if (payload) {
    if (bodyMode === 'form') {
      options.payload = payload;
    } else {
      options.contentType = 'application/json';
      options.payload = JSON.stringify(payload);
    }
  }

  const response = UrlFetchApp.fetch(url, options);
  const text = response.getContentText();

  let json = null;
  try { json = JSON.parse(text); } catch (e) {}

  return {
    ok: response.getResponseCode() >= 200 && response.getResponseCode() < 300,
    status: response.getResponseCode(),
    raw: text,
    json: json,
    url: url,
    request: {
      method: method || 'get',
      bodyMode: bodyMode || '',
      payload: payload || null,
      url: url
    }
  };
}

function postPrecifJson_(endpoint, payload) {
  return requestPrecif_('post', endpoint, payload, 'json');
}

function postPrecifForm_(endpoint, payload) {
  return requestPrecif_('post', endpoint, payload, 'form');
}

function buildPrecifCacheKey_(payload) {
  return [
    'FICHA_PRECIF',
    String(payload.placa || ''),
    String(payload.marca || ''),
    String(payload.modelo || ''),
    String(payload.ano || ''),
    String(payload.versao || ''),
    String(payload.km || '')
  ].join('|');
}

function getPrecifCache_(key) {
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setPrecifCache_(key, value) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), PRECIF_CACHE_TTL_SECONDS);
  } catch (e) {}
}

function consultarPrecificacaoFicha(payloadFront) {
  const endpoint = '/api/regra_precificacao/preco_loja';

  const payload = {
    placa: String(payloadFront?.placa || '').trim(),
    marca: String(payloadFront?.marca || '').trim(),
    modelo: String(payloadFront?.modelo || '').trim(),
    ano: String(payloadFront?.ano || '').trim(),
    versao: String(payloadFront?.versao || '').trim(),
    km: String(payloadFront?.km || '').trim()
  };

  if (!payload.marca || !payload.modelo || !payload.ano || !payload.versao || !payload.km) {
    return {
      ok: false,
      error: 'Dados insuficientes para consultar o precificador.'
    };
  }

  const cacheKey = buildPrecifCacheKey_(payload);
  const cached = getPrecifCache_(cacheKey);
  if (cached) {
    cached.cached = true;
    return cached;
  }

  const attempts = [];
  const senders = [
    { name: 'json', fn: postPrecifJson_ },
    { name: 'form', fn: postPrecifForm_ }
  ];

  for (let s = 0; s < senders.length; s++) {
    const resp = senders[s].fn(endpoint, {
      marca: payload.marca,
      km: payload.km,
      ano: payload.ano,
      modelo: payload.modelo,
      versao: payload.versao
    });

    attempts.push({
      endpoint: endpoint,
      status: resp.status,
      request: resp.request,
      raw: resp.raw
    });

    if (resp.status === 200 && resp.json) {
      const data = resp.json || {};
      const out = {
        ok: true,
        cached: false,
        data: {
          valorPrecificador: Math.round(Number(data.preco || 0)),
          valorFipe: Math.round(Number(data.valor_fipe || 0)),
          precoMaximo: Number(data.preco || 0),
          precoMinimo: Number(data.preco_menor || 0),
          valorFipeExibicao: Number(data.valor_fipe || 0)
        },
        debug: attempts
      };

      setPrecifCache_(cacheKey, out);
      return out;
    }
  }

  return {
    ok: false,
    error: 'Falha ao consultar o precificador.',
    debug: attempts
  };
}

// ===== WEB APP =====
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Ficha Mecânica');
}

function getBootstrapData() {
  ensureSheets_();
  ensureControlColumns_();
  ensureEmailSettings_();
  const cfg = getAppConfig_();

  return {
    catalogs: loadCatalogs_(),
    nowISO: new Date().toISOString(),
    appVersion: APP_VERSION,
    appEnv: cfg.env,
    isLab: cfg.isLab,
    hasAdminPassword: !!PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_PASSWORD)
  };
}

function submitInspection(payload) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    ensureSheets_();
    ensureControlColumns_();
    ensureEmailSettings_();

    validateInspectionPayload_(payload);

    const submitKey = String(payload?.meta?.submitKey || '').trim();
    if (!submitKey) {
      throw new Error('Chave de envio ausente. Recarregue o app e tente novamente.');
    }

    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName(SHEET_FICHAS);

    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const headersTrim = headers.map(h => String(h || '').trim());

    const colSubmitKey = headersTrim.indexOf('SubmitKey') + 1;
    const colStatus = headersTrim.indexOf('Status') + 1;
    const colPdf = headersTrim.indexOf('PDF_URL') + 1;

    if (colSubmitKey) {
      const existingRow = findRowBySubmitKey_(sh, colSubmitKey, submitKey);

      if (existingRow) {
        const status = colStatus ? String(sh.getRange(existingRow, colStatus).getValue() || '').trim().toUpperCase() : '';
        const pdfUrl = colPdf ? sh.getRange(existingRow, colPdf).getValue() : '';

        if (status === 'ENVIADO') {
          return {
            ok: true,
            duplicate: true,
            rowNumber: existingRow,
            status: status,
            pdfUrl: pdfUrl,
            message: 'Esta ficha já havia sido enviada. O envio duplicado foi bloqueado.'
          };
        }

        if (status === 'PROCESSANDO') {
          return {
            ok: true,
            duplicate: true,
            rowNumber: existingRow,
            status: status,
            pdfUrl: pdfUrl,
            message: 'Esta ficha já está em processamento. Aguarde a conclusão.'
          };
        }

        // Se a linha existe, mas não foi concluída, reprocessa a mesma linha sem criar duplicidade.
        processRow_(existingRow, payload);

        return {
          ok: true,
          duplicate: true,
          reprocessed: true,
          rowNumber: existingRow,
          status: 'ENVIADO'
        };
      }
    }

    const flat = buildFlatRow_(payload, headers);

    flat['Status'] = 'PENDENTE';
    flat['UltimoErro'] = '';
    flat['PDF_URL'] = '';
    flat['EnviadoEm'] = '';
    flat['SubmitKey'] = submitKey;

    const row = headers.map(h => {
      const key = String(h || '').trim();
      return flat[h] ?? flat[key] ?? '';
    });

    sh.appendRow(row);

    const rowNumber = sh.getLastRow();
    processRow_(rowNumber, payload);

    return {
      ok: true,
      duplicate: false,
      rowNumber: rowNumber
    };

  } finally {
    try {
      lock.releaseLock();
    } catch (e) {}
  }
}

function findRowBySubmitKey_(sh, colSubmitKey, submitKey) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const values = sh.getRange(2, colSubmitKey, lastRow - 1, 1).getValues();

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === submitKey) {
      return i + 2;
    }
  }

  return 0;
}

// ===== PROCESSAMENTO (PDF + EMAIL) =====
function processRow_(rowNumber, originalPayload) {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_FICHAS);

  const headersRaw = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const values = sh.getRange(rowNumber, 1, 1, sh.getLastColumn()).getValues()[0];

  const data = {};
  headersRaw.forEach((h, i) => {
    const key = String(h || '').trim();
    if (!key) return;
    data[key] = values[i];
  });

  const headersTrim = headersRaw.map(h => String(h || '').trim());
  const colStatus = headersTrim.indexOf('Status') + 1;
  const colErro   = headersTrim.indexOf('UltimoErro') + 1;
  const colPdf    = headersTrim.indexOf('PDF_URL') + 1;
  const colEnvEm  = headersTrim.indexOf('EnviadoEm') + 1;

  const statusAtual = String(data['Status'] || '').trim().toUpperCase();
  if (statusAtual === 'ENVIADO') return;

  try {
    if (colStatus) sh.getRange(rowNumber, colStatus).setValue('PROCESSANDO');
    if (colErro)   sh.getRange(rowNumber, colErro).setValue('');

    if (originalPayload) {
      validateInspectionPayload_(originalPayload);
    }

    const pdfFile = generatePdfFromRow_(data);
    sendEmailFromRow_(data, pdfFile, originalPayload);

    if (colStatus) sh.getRange(rowNumber, colStatus).setValue('ENVIADO');
    if (colPdf)    sh.getRange(rowNumber, colPdf).setValue(pdfFile.getUrl());
    if (colEnvEm)  sh.getRange(rowNumber, colEnvEm).setValue(new Date());

  } catch (err) {
    if (colStatus) sh.getRange(rowNumber, colStatus).setValue('ERRO');
    if (colErro)   sh.getRange(rowNumber, colErro).setValue(String(err && err.message ? err.message : err));
    throw err;
  }
}

// Reprocessa se limpar Status ou colocar PENDENTE
function onEdit(e) {
  const range = e.range;
  const sh = range.getSheet();
  if (sh.getName() !== SHEET_FICHAS) return;
  if (range.getRow() === 1) return;

  const headersRaw = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const headersTrim = headersRaw.map(h => String(h || '').trim());
  const colStatus = headersTrim.indexOf('Status') + 1;
  if (!colStatus) return;
  if (range.getColumn() !== colStatus) return;

  const newVal = String(range.getValue() || '').trim().toUpperCase();
  if (newVal === '' || newVal === 'PENDENTE') {
    if (newVal === '') range.setValue('PENDENTE');
    processRow_(range.getRow(), null);
  }
}

// ===== CADASTROS =====
function loadCatalogs_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CATALOGS_CACHE_KEY);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // ignora cache inválido
    }
  }

  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_CAD);
  const values = sh.getDataRange().getValues();

  if (values.length < 2) {
    const emptyResult = {};
    try {
      cache.put(CATALOGS_CACHE_KEY, JSON.stringify(emptyResult), CATALOGS_CACHE_TTL_SECONDS);
    } catch (e) {}
    return emptyResult;
  }

  const catalogs = {};
  const cols = values[0].length;
  const rows = values.length;

  for (let c = 0; c < cols; c++) {
    const key = String(values[0][c] || '').trim();
    if (!key) continue;

    const list = [];
    for (let r = 1; r < rows; r++) {
      const v = String(values[r][c] || '').trim();
      if (v) list.push(v);
    }

    const seen = new Set();
    catalogs[key] = list.filter(x => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  }

  try {
    cache.put(CATALOGS_CACHE_KEY, JSON.stringify(catalogs), CATALOGS_CACHE_TTL_SECONDS);
  } catch (e) {
    // se exceder o limite do cache, apenas segue
  }

  return catalogs;
}

function clearCatalogsCache_() {
  CacheService.getScriptCache().remove(CATALOGS_CACHE_KEY);
}

function resetCatalogsCache() {
  clearCatalogsCache_();
  return 'Cache dos catálogos limpo com sucesso.';
}

// ===== HELPERS =====
function ensureSheets_() {
  const ss = getSpreadsheet_();
  if (!ss.getSheetByName(SHEET_CAD)) throw new Error(`Aba ${SHEET_CAD} não existe`);
  if (!ss.getSheetByName(SHEET_FICHAS)) throw new Error(`Aba ${SHEET_FICHAS} não existe`);
}

function ensureControlColumns_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_FICHAS);

  const lastCol = Math.max(1, sh.getLastColumn());
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());

  const existing = new Set(headers.filter(Boolean));
  CTRL_COLS.forEach(colName => {
    if (!existing.has(colName)) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(colName);
      existing.add(colName);
    }
  });
}

// ===== PLACA =====
function normalizePlaca_(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function validatePlaca_(placaNorm) {
  const re = /^([A-Z]{3}\d{4}|[A-Z]{3}\d[A-Z]\d{2})$/;
  return re.test(placaNorm);
}

// ===== CONSULTA POR PLACA - TONY / INFOCAR =====
/**
 * Função pública chamada pelo front.
 * Mantém o mesmo contrato que o app já usa:
 * - retorno.ok
 * - retorno.found
 * - retorno.avisoConferencia
 * - retorno.sugestao
 * - retorno.normalized
 *
 * A diferença é que a origem deixa de ser Autoglass e passa a ser Tony/Infocar.
 * Os dados completos ficam preservados em normalized.extras para melhorias futuras.
 */
function suggestVehicleFieldsFromPlate(input) {
  const placa = normalizePlaca_(input?.placa || '');
  if (!placa || !validatePlaca_(placa)) {
    return {
      ok: false,
      found: false,
      reason: 'Placa inválida.'
    };
  }

  const plateResult = prefetchVehicleByPlateTonyInfocar({ placa });
  const catalogs = loadCatalogs_();

  if (!plateResult.ok || !plateResult.found) {
    return {
      ok: true,
      found: false,
      avisoConferencia: 'Placa não localizada. O preenchimento deve seguir manualmente.',
      sugestao: {
        placa,
        marcaSelecionadaCadastro: '',
        marcaSugerida: '',
        modeloBase: '',
        selectedModeloCadastro: '',
        usarModeloOutro: false,
        modeloOutroSugerido: '',
        anoFabricacaoSugerido: '',
        anoModeloSugerido: '',
        versaoSugerida: '',
        fipeIdSugerido: ''
      },
      normalized: plateResult.normalized || {},
      error: plateResult.error || ''
    };
  }

  const marcaMatch = findBestMarcaMatch_(plateResult.normalized.marca, catalogs.marcas || []);
  const modeloMatch = findBestCadastroMatch_(plateResult.normalized, catalogs.modelos_versao || []);

  return {
    ok: true,
    found: true,
    avisoConferencia: buildAvisoConferencia_(plateResult.normalized, modeloMatch),
    sugestao: {
      placa: plateResult.normalized.placa || placa,
      marcaSelecionadaCadastro: marcaMatch.selectedOption || '',
      marcaSugerida: plateResult.normalized.marca || '',
      marcaFallbackApi: (!marcaMatch.selectedOption && plateResult.normalized.marca) ? plateResult.normalized.marca : '',
      marcaMatchTipo: marcaMatch.matchTipo || '',
      modeloBase: plateResult.normalized.modelo || '',
      selectedModeloCadastro: modeloMatch.selectedOption || '',
      usarModeloOutro: !!modeloMatch.shouldUseOutro,
      modeloOutroSugerido: modeloMatch.suggestedOutro || '',
      anoFabricacaoSugerido: plateResult.normalized.anoFabricacao || '',
      anoModeloSugerido: plateResult.normalized.anoModelo || '',
      versaoSugerida: (plateResult.normalized.fipeOptions?.[0]?.versao) || '',
      fipeIdSugerido: (plateResult.normalized.fipeOptions?.[0]?.fipeId) || '',
      matchTipo: modeloMatch.matchTipo || '',
      matchPontuacao: modeloMatch.score || 0
    },
    normalized: plateResult.normalized,
    error: plateResult.error || ''
  };
}

function prefetchVehicleByPlateTonyInfocar(input) {
  const placa = normalizePlaca_(input?.placa || '');
  if (!placa || !validatePlaca_(placa)) {
    return {
      ok: false,
      found: false,
      reason: 'Placa inválida.'
    };
  }

  const cacheKey = buildTonyInfocarPlateCacheKey_(placa);
  const cached = getTonyInfocarPlateCache_(cacheKey);
  if (cached) {
    return {
      ok: true,
      cached: true,
      found: !!cached?.normalized?.found,
      normalized: cached.normalized || {},
      raw: cached.raw || null,
      error: cached.error || ''
    };
  }

  const fetched = fetchVehicleByPlateTonyInfocar_(placa);
  setTonyInfocarPlateCache_(cacheKey, fetched);

  return {
    ok: fetched.ok,
    cached: false,
    found: !!fetched?.normalized?.found,
    normalized: fetched.normalized || {},
    raw: fetched.raw || null,
    error: fetched.error || ''
  };
}

function fetchVehicleByPlateTonyInfocar_(placa) {
  let renavamPayload = null;
  let fipePayload = null;
  const errors = [];

  try {
    renavamPayload = consultarTonyInfocarFicha_({ placa, tipo: 'consulta_renavam' });
  } catch (e) {
    errors.push('consulta_renavam: ' + String(e && e.message ? e.message : e));
  }

  try {
    fipePayload = consultarTonyInfocarFicha_({ placa, tipo: 'codificacao_fipe_plus' });
  } catch (e) {
    errors.push('codificacao_fipe_plus: ' + String(e && e.message ? e.message : e));
  }

  const normalized = normalizeTonyInfocarVehicleResponse_(placa, renavamPayload, fipePayload);

  return {
    ok: !!(renavamPayload || fipePayload),
    placa,
    status: renavamPayload || fipePayload ? 200 : 0,
    raw: {
      consulta_renavam: renavamPayload,
      codificacao_fipe_plus: fipePayload
    },
    normalized,
    error: errors.join(' | ')
  };
}

function consultarTonyInfocarFicha_(params) {
  const placa = normalizePlaca_(params?.placa || '');
  const tipo = String(params?.tipo || '').trim();

  if (!placa || !validatePlaca_(placa)) throw new Error('Placa inválida para consulta Tony/Infocar.');
  if (!tipo) throw new Error('Tipo de consulta Tony/Infocar não informado.');

  const token = getTonyInfocarTokenFicha_();
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= TONY_INFOCAR_MAX_TENTATIVAS; tentativa++) {
    const usarFallbackSSL = tentativa === TONY_INFOCAR_MAX_TENTATIVAS;

    try {
      const resp = UrlFetchApp.fetch(TONY_INFOCAR_API_URL, {
        method: 'post',
        muteHttpExceptions: true,
        validateHttpsCertificates: !usarFallbackSSL,
        headers: {
          Authorization: 'Token ' + token,
          Accept: 'application/json'
        },
        payload: {
          placa: placa,
          tipo: tipo
        }
      });

      const status = resp.getResponseCode();
      const text = resp.getContentText();

      if (status >= 200 && status < 300) {
        try {
          return JSON.parse(text || '{}');
        } catch (jsonErr) {
          throw new Error('Resposta não é JSON válido em ' + tipo + ': ' + String(text).slice(0, 500));
        }
      }

      ultimoErro = new Error('HTTP ' + status + ' em ' + tipo + ': ' + String(text).slice(0, 500));
    } catch (e) {
      ultimoErro = e;
    }

    if (tentativa < TONY_INFOCAR_MAX_TENTATIVAS) {
      Utilities.sleep(1200 * tentativa);
    }
  }

  throw new Error('Falha após ' + TONY_INFOCAR_MAX_TENTATIVAS + ' tentativas em ' + tipo + ': ' + String(ultimoErro));
}

function getTonyInfocarTokenFicha_() {
  let token = PropertiesService.getScriptProperties().getProperty('TOKEN_API');

  if (!token) {
    throw new Error('TOKEN_API não encontrado nas Script Properties deste projeto de Avaliação/Ficha Mecânica.');
  }

  token = String(token).trim();
  if (/^Token\s+/i.test(token)) token = token.replace(/^Token\s+/i, '').trim();
  return token;
}

function normalizeTonyInfocarVehicleResponse_(placa, renavamPayload, fipePayload) {
  const ren = renavamPayload?.infocar || {};
  const fip = fipePayload?.infocar || {};

  const placaRetorno = String(ren.placa || fip.placa || placa || '').toUpperCase();
  const marca = firstNonEmpty_(
    fipePayload?.marca_v2_precificador,
    fipePayload?.marca_v1_precificador,
    extractMarcaFromDescricaoFipe_(fip.fipes_descricao),
    extractMarcaFromModelo_(fip.modelo || ren.modelo)
  );

  const modelo = firstNonEmpty_(
    fipePayload?.modelo_precificador,
    limparModeloDocumental_(fip.modelo, marca),
    limparModeloDocumental_(ren.modelo, marca)
  );

  const versao = firstNonEmpty_(
    fipePayload?.versao_precificador,
    fip.fipes_descricao,
    fip.molicars_descricao
  );

  const anoFabricacao = String(ren.anoFabricacao || fip.anoFabricacao || '');
  const anoModelo = String(ren.anoModelo || fip.anoModelo || '');
  const cilindradas = String(fip.numeroCilindradas || '');

  const fipeOptions = [];
  if (fip.fipes_codigoFipe || fip.fipes_descricao || fip.fipes_valor || versao) {
    fipeOptions.push({
      fipeId: String(fip.fipes_codigoFipe || ''),
      modelo: String(modelo || fip.modelo || ren.modelo || ''),
      ano: String(anoModelo || anoFabricacao || ''),
      marca: String(marca || ''),
      versao: String(versao || ''),
      combustivel: String(fip.combustivel || ren.combustivel || ''),
      valorAtual: String(fip.fipes_valor || ''),
      label: buildModeloVersaoLabel_(modelo, versao, ' - ')
    });
  }

  const veiculoDescricao = buildTonyVehicleDescription_({
    marca,
    modelo,
    versao,
    anoFabricacao,
    anoModelo
  });

  const out = {
    found: !!(
      marca ||
      modelo ||
      versao ||
      anoFabricacao ||
      anoModelo ||
      ren.chassi ||
      ren.renavam ||
      fipeOptions.length
    ),
    placa: placaRetorno || placa,

    // Campos já usados pelo front atual
    marca: String(marca || ''),
    modelo: String(modelo || ''),
    anoFabricacao: anoFabricacao,
    anoModelo: anoModelo,
    cilindradas: cilindradas,
    veiculoDescricao: veiculoDescricao,
    fipeOptions: fipeOptions,

    // Dados completos reservados para melhorias futuras
    extras: {
      chassi: String(ren.chassi || fip.chassi || ''),
      renavam: String(ren.renavam || ''),
      cor: String(fip.cor || ren.cor || ''),
      combustivel: String(fip.combustivel || ren.combustivel || ''),
      uf: String(ren.uf || ''),
      modeloDocumental: String(ren.modelo || ''),
      modeloComercial: String(fip.modelo || ''),
      tipoVeiculo: String(fip.tipoVeiculo || ''),
      especie: String(fip.especie || ''),
      carroceria: String(fip.carroceria || ''),
      potencia: String(fip.potencia || ''),
      cilindradas: cilindradas,
      quantidadeEixos: String(fip.quantidadeDeEixos || ''),
      motor: String(fip.motor || ''),
      descricaoCarroceria: String(fip.descricaoCarroceria || ''),
      fipeCodigo: String(fip.fipes_codigoFipe || ''),
      fipeDescricao: String(fip.fipes_descricao || ''),
      fipeValor: String(fip.fipes_valor || ''),
      molicarCodigo: String(fip.molicars_codigoMolicar || ''),
      molicarDescricao: String(fip.molicars_descricao || ''),
      molicarValor: String(fip.molicars_valor || ''),
      versaoPrecificador: String(fipePayload?.versao_precificador || ''),
      modeloPrecificador: String(fipePayload?.modelo_precificador || ''),
      marcaV1Precificador: String(fipePayload?.marca_v1_precificador || ''),
      marcaV2Precificador: String(fipePayload?.marca_v2_precificador || ''),
      rawConsultaRenavamDisponivel: !!renavamPayload,
      rawCodificacaoFipePlusDisponivel: !!fipePayload
    }
  };

  return out;
}

function buildTonyVehicleDescription_(vehicle) {
  const marca = String(vehicle?.marca || '').trim();
  const modelo = String(vehicle?.modelo || '').trim();
  const versao = String(vehicle?.versao || '').trim();
  const ano = vehicle?.anoFabricacao || vehicle?.anoModelo
    ? String(vehicle?.anoFabricacao || '') + '/' + String(vehicle?.anoModelo || '')
    : '';

  const chunks = [];
  if (marca) chunks.push(marca);

  const versaoNorm = normalizeText_(versao);
  const modeloNorm = normalizeText_(modelo);

  if (modelo && (!versaoNorm || !modeloNorm || !versaoNorm.includes(modeloNorm))) {
    chunks.push(modelo);
  }

  if (versao) chunks.push(versao);
  if (ano && ano !== '/') chunks.push(ano);

  return chunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}


function modeloVersaoTemDuplicidade_(modelo, versao) {
  const modeloNorm = normalizeText_(modelo || '');
  const versaoNorm = normalizeText_(versao || '');
  if (!modeloNorm || !versaoNorm) return false;
  return versaoNorm.indexOf(modeloNorm) === 0 || versaoNorm.indexOf(modeloNorm) >= 0;
}

function buildModeloVersaoLabel_(modelo, versao, separator) {
  const m = String(modelo || '').trim();
  const v = String(versao || '').trim();
  const sep = separator === undefined ? ' ' : String(separator);

  if (m && v) {
    if (modeloVersaoTemDuplicidade_(m, v)) return v;
    if (modeloVersaoTemDuplicidade_(v, m)) return m;
    return m + sep + v;
  }

  return m || v || '';
}

function firstNonEmpty_() {
  for (let i = 0; i < arguments.length; i++) {
    const value = String(arguments[i] || '').trim();
    if (value) return value;
  }
  return '';
}

function extractMarcaFromDescricaoFipe_(descricao) {
  const s = String(descricao || '').trim();
  if (!s) return '';
  return s.split(/\s+/)[0] || '';
}

function extractMarcaFromModelo_(modelo) {
  const s = String(modelo || '').trim();
  if (!s) return '';
  if (s.indexOf('/') >= 0) return s.split('/')[0];
  return '';
}

function limparModeloDocumental_(modelo, marca) {
  let s = String(modelo || '').trim();
  const m = String(marca || '').trim();
  if (!s) return '';

  if (s.indexOf('/') >= 0) {
    const parts = s.split('/');
    if (parts.length > 1) s = parts.slice(1).join('/');
  }

  if (m) {
    const re = new RegExp('^' + escapeRegExp_(m) + '\\s+', 'i');
    s = s.replace(re, '');
  }

  return s.trim();
}

function escapeRegExp_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTonyInfocarPlateCacheKey_(placa) {
  return 'TONY_INFOCAR_PLATE_' + normalizePlaca_(placa || '');
}

function getTonyInfocarPlateCache_(key) {
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setTonyInfocarPlateCache_(key, obj) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(obj), TONY_INFOCAR_PLACA_CACHE_TTL_SECONDS);
  } catch (e) {}
}

function findBestMarcaMatch_(marca, cadastroMarcas) {
  const marcas = (cadastroMarcas || []).map(x => String(x || '').trim()).filter(Boolean);
  const candidates = buildMarcaCandidates_(marca);

  if (!candidates.length) return { selectedOption: '' };

  // 1) Match exato entre qualquer candidato normalizado e o cadastro.
  for (let i = 0; i < marcas.length; i++) {
    const opt = normalizeText_(marcas[i]);
    if (candidates.indexOf(opt) >= 0) {
      return { selectedOption: marcas[i], matchTipo: 'marca_exata_alias' };
    }
  }

  // 2) Match por contenção, útil para cadastros como "CAOA CHERY" x API "Chery Caoa".
  for (let i = 0; i < marcas.length; i++) {
    const opt = normalizeText_(marcas[i]);
    for (let j = 0; j < candidates.length; j++) {
      const c = candidates[j];
      if (opt && c && (opt.includes(c) || c.includes(opt))) {
        return { selectedOption: marcas[i], matchTipo: 'marca_contem_alias' };
      }
    }
  }

  return { selectedOption: '' };
}

function buildMarcaCandidates_(marca) {
  const raw = String(marca || '').trim();
  if (!raw) return [];

  const normalized = normalizeText_(raw);
  const spaced = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();

  const tokens = spaced.split(/\s+/).filter(Boolean);
  const out = [];

  function add(v) {
    const n = normalizeText_(v);
    if (n && out.indexOf(n) < 0) out.push(n);
  }

  add(raw);

  // Inverte ordem de marcas compostas: "Chery Caoa" -> "Caoa Chery".
  if (tokens.length > 1) {
    add(tokens.slice().reverse().join(' '));
  }

  // Adiciona tokens individuais para quando o cadastro usa apenas a marca principal.
  tokens.forEach(add);

  const hasChery = tokens.indexOf('chery') >= 0;
  const hasCaoa = tokens.indexOf('caoa') >= 0 || tokens.indexOf('caao') >= 0;

  // Equivalências comuns da CAOA Chery.
  if (hasChery && hasCaoa) {
    add('CAOA CHERY');
    add('CAOA-CHERY');
    add('CHERY CAOA');
    add('CHERY');
    add('CAOA');
  }

  // Equivalências comuns para evitar novos casos manuais no cadastro.
  const aliasGroups = [
    ['vw', 'volkswagen'],
    ['gm', 'chevrolet'],
    ['mercedes', 'mercedes benz', 'mercedes-benz'],
    ['citroen', 'citroën'],
    ['caoa chery', 'caoa-chery', 'chery caoa', 'chery']
  ];

  aliasGroups.forEach(function(group) {
    const groupNorm = group.map(normalizeText_);
    const hit = groupNorm.some(function(g) { return out.indexOf(g) >= 0; });
    if (hit) group.forEach(add);
  });

  return out;
}

function findBestCadastroMatch_(vehicle, cadastroModelos) {
  const cadastro = (cadastroModelos || []).map(x => String(x || '').trim()).filter(Boolean);
  const candidates = buildVehicleCandidates_(vehicle);

  let best = {
    matched: false,
    selectedOption: '',
    shouldUseOutro: false,
    suggestedOutro: '',
    matchTipo: '',
    score: 0
  };

  for (let i = 0; i < cadastro.length; i++) {
    const opt = cadastro[i];
    const scoreObj = scoreCadastroOption_(vehicle, opt, candidates);
    if (scoreObj.score > best.score) {
      best = {
        matched: scoreObj.score >= 70,
        selectedOption: scoreObj.score >= 70 ? opt : '',
        shouldUseOutro: false,
        suggestedOutro: '',
        matchTipo: scoreObj.matchTipo,
        score: scoreObj.score
      };
    }
  }

  if (best.matched) return best;

  const sugestaoOutro = buildModeloOutroSuggestion_(vehicle);

  return {
    matched: false,
    selectedOption: '',
    shouldUseOutro: !!sugestaoOutro,
    suggestedOutro: sugestaoOutro,
    matchTipo: best.matchTipo || '',
    score: best.score || 0
  };
}

function buildVehicleCandidates_(vehicle) {
  const out = [];

  if (vehicle?.modelo) out.push(String(vehicle.modelo));
  if (vehicle?.veiculoDescricao) out.push(String(vehicle.veiculoDescricao));

  (vehicle?.fipeOptions || []).forEach(x => {
    if (x.label) out.push(String(x.label));
    if (x.versao) out.push(String(x.versao));
    if (x.modelo) out.push(String(x.modelo));
    if (x.modelo && x.versao) out.push(`${x.modelo} ${x.versao}`);
  });

  return Array.from(new Set(out.filter(Boolean)));
}

function buildModeloOutroSuggestion_(vehicle) {
  const firstFipe = vehicle?.fipeOptions?.[0] || {};
  return buildModeloVersaoLabel_(vehicle?.modelo || '', firstFipe?.versao || '', ' - ');
}

function scoreCadastroOption_(vehicle, option, candidates) {
  const optNorm = normalizeText_(option);
  const modeloNorm = normalizeText_(vehicle?.modelo || '');
  const versaoNorm = normalizeText_(vehicle?.fipeOptions?.[0]?.versao || '');
  const descricaoNorm = normalizeText_(vehicle?.veiculoDescricao || '');

  let score = 0;
  let matchTipo = '';

  if (!optNorm) return { score: 0, matchTipo: '' };

  if (candidates.some(c => normalizeText_(c) === optNorm)) {
    return { score: 100, matchTipo: 'exato' };
  }

  if (modeloNorm && optNorm.includes(modeloNorm)) {
    score += 40;
    matchTipo = 'modelo';
  }

  if (versaoNorm) {
    const versaoTokens = splitTokens_(versaoNorm);
    let versaoHits = 0;
    versaoTokens.forEach(t => {
      if (t.length >= 2 && optNorm.includes(t)) versaoHits++;
    });

    if (versaoTokens.length) {
      score += Math.min(45, Math.round((versaoHits / versaoTokens.length) * 45));
      if (versaoHits > 0) matchTipo = matchTipo ? (matchTipo + '+versao') : 'versao';
    }
  }

  if (descricaoNorm && (descricaoNorm.includes(optNorm) || optNorm.includes(descricaoNorm))) {
    score = Math.max(score, 85);
    matchTipo = 'descricao';
  }

  if (vehicle?.anoModelo && optNorm.includes(String(vehicle.anoModelo))) {
    score += 10;
  }

  return {
    score: Math.min(100, score),
    matchTipo
  };
}

function splitTokens_(txt) {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function buildAvisoConferencia_(vehicle, modeloMatch) {
  if (!vehicle?.found) {
    return 'Placa não localizada. O preenchimento deve seguir manualmente.';
  }

  if (modeloMatch?.selectedOption) {
    return 'Veículo localizado pela placa. Confira os dados com o documento antes de continuar.';
  }

  return 'Veículo localizado pela placa, mas o modelo/versão não casou exatamente com o cadastro. Confira e use "Outro modelo/versão" se necessário.';
}

function buildAutoglassPlateCacheKey_(placa) {
  return 'AUTOGLASS_PLATE_' + normalizePlaca_(placa || '');
}

function getAutoglassPlateCache_(key) {
  const raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setAutoglassPlateCache_(key, obj) {
  CacheService.getScriptCache().put(key, JSON.stringify(obj), AUTOGLASS_PLACA_CACHE_TTL_SECONDS);
}

function normalizeText_(txt) {
  return String(txt || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .trim();
}

// ===== VALIDAÇÃO DE PAYLOAD =====
function validateInspectionPayload_(payload) {
  const placaNorm = normalizePlaca_(payload?.basico?.placa || '');
  if (placaNorm && !validatePlaca_(placaNorm)) {
    throw new Error('Placa inválida (esperado ABC1234 ou ABC1D23).');
  }

  const secoes = payload?.secoes || {};
  const labels = {
    funilaria: 'Funilaria',
    tapecaria: 'Tapeçaria',
    eletrica: 'Elétrica',
    mecanica: 'Mecânica',
    suspensao: 'Suspensão',
    pneusDianteiros: 'Pneus Dianteiros',
    pneusTraseiros: 'Pneus Traseiros',
    vidros: 'Vidros',
    ferramentas: 'Ferramentas',
    estepe: 'Estepe',
    arCondicionado: 'Ar condicionado',
    lavagem: 'Lavagem'
  };

  Object.keys(labels).forEach(key => {
    const s = secoes[key];
    if (!s || !s.tem) return;

    const itens = Array.isArray(s.itens) ? s.itens : [];
    const outro = String(s.outro || '').trim();
    const valor = Number(s.valor || 0);

    if (!itens.length) {
      throw new Error(`Selecione ao menos 1 item na seção "${labels[key]}".`);
    }

    if (!valor || valor <= 0) {
      throw new Error(`A seção "${labels[key]}" foi marcada com apontamento e precisa ter valor informado.`);
    }

    const hasOutro = itens.some(x => String(x || '').toLowerCase().startsWith('outro'));
    if (hasOutro && !outro) {
      throw new Error(`Você selecionou "Outro" na seção "${labels[key]}", então precisa descrever o apontamento.`);
    }
  });
}

// ===== FLATTEN =====
function buildFlatRow_(p, headers) {
  const out = {};
  out['Carimbo de data/hora'] = new Date();

  const id = Utilities.getUuid();
  if (headers.includes('ID')) out['ID'] = id;
  if (headers.includes('VersaoApp')) out['VersaoApp'] = APP_VERSION;

  const placaNorm = normalizePlaca_(p?.basico?.placa);
  if (placaNorm && !validatePlaca_(placaNorm)) {
    throw new Error('Placa inválida (esperado ABC1234 ou ABC1D23).');
  }

  out['Avaliador'] = p?.basico?.avaliador || '';
  out['Analista'] = p?.basico?.analista || '';
  out['Data e Hora'] = p?.basico?.dataHora || '';
  out['Cliente'] = p?.basico?.cliente || '';
  out['Celular'] = p?.basico?.celular || '';
  out['Email'] = p?.basico?.email || '';
  out['Placa'] = placaNorm;
  out['Marca do Veículo'] = p?.basico?.marca || '';
  out['Modelo e versão'] = p?.basico?.modeloVersao || '';
  out['Versão'] = p?.basico?.versao || '';
  out['Ano/Modelo'] = p?.basico?.anoModelo || '';
  out['Cor'] = p?.basico?.cor || '';
  out['KM Atual'] = p?.basico?.kmAtual ?? '';

  mapSec_(out, p, 'funilaria', 'Funilaria', 'Custo Funilaria', 'Descreva as peças de funilaria');
  mapSec_(out, p, 'tapecaria', 'Tapeçaria', 'Custo Tapeçaria', 'Descreva Tapeçaria');
  mapSec_(out, p, 'eletrica', 'Elétrica', 'Custo Elétrica', 'Descrição da Elétrica');
  mapSec_(out, p, 'mecanica', 'Mecânica', 'Custo Mecânica', 'Descrição da Mecânica');
  mapSec_(out, p, 'suspensao', 'Suspensão', 'Custo Suspensão', 'Descrição da Suspensão');
  mapSec_(out, p, 'pneusDianteiros', 'Pneus Dianteiros', 'Custo Pneus dianteiros', 'Descrição sobre os Pneus');
  mapSec_(out, p, 'pneusTraseiros', 'Pneus Traseiros', 'Custo Pneus Traseiros', 'Descrição Pneus Traseiros');
  mapSec_(out, p, 'vidros', 'Vidros', 'Custo dos Vidros', 'Descrição dos Vidros');
  mapSec_(out, p, 'ferramentas', 'Ferramentas', 'Custo Ferramentas', 'Descrição de Ferramentas');
  mapSec_(out, p, 'estepe', 'Estepe', 'Custo Estepe', 'Descrição sobre o Estepe');
  mapSec_(out, p, 'arCondicionado', 'Ar condicionado', 'Custo do Ar Condicionado', 'Descrição sobre o Ar Condicionado');
  mapSec_(out, p, 'lavagem', 'Lavagem', 'Custo da Lavagem', 'Descrição da Lavagem');

  out['Opcionais'] = (p?.checklists?.opcionais || []).join(', ');
  out['Avaliacao'] = (p?.checklists?.avaliacoes || []).join(', ');

  out['Valor Total da Ficha'] = p?.fechamento?.valorTotalFicha ?? '';
  out['Valor do Precificador'] = p?.fechamento?.valorPrecificador ?? '';
  out['Valor da Fipe'] = p?.fechamento?.valorFipe ?? '';
  out['Valor do débitos de multa'] = p?.fechamento?.debitosMulta ?? '';
  out['Possui quitação'] = p?.fechamento?.quitacao ?? '';
  out['Quanto cliente quer ? (oriente a ele que normalmente é precificador menos ficha)'] =
    p?.fechamento?.clienteQuer ?? '';
  out['Observações Relevantes'] = p?.fechamento?.observacoes ?? '';

  return out;
}

function mapSec_(out, p, key, colStatus, colValor, colDesc) {
  const s = p?.secoes?.[key];
  if (!s) return;

  out[colStatus] = s.tem ? 'RUIM' : 'BOM';
  out[colValor] = (s.valor ?? '');

  const itens = (s.itens || []).join(', ');
  const outro = (s.outro || '').trim();
  out[colDesc] = itens + (outro ? ` | Outro: ${outro}` : '');
}

// ===== PDF =====
function generatePdfFromRow_(data) {
  const cfg = getAppConfig_();
  if (!cfg.pdfFolderId) throw new Error('PDF_FOLDER_ID não configurado.');
  if (!cfg.docTemplateId) throw new Error('DOC_TEMPLATE_ID não configurado.');

  const folder = DriveApp.getFolderById(cfg.pdfFolderId);

  const placa = String(data['Placa'] || 'SEMPLACA').toUpperCase();
  const cliente = String(data['Cliente'] || 'CLIENTE').replace(/[^\w\s-]/g,'').trim();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');

  const tmpName = `TMP_${placa}_${cliente}_${stamp}`;
  const tmpFile = DriveApp.getFileById(cfg.docTemplateId).makeCopy(tmpName, folder);

  const doc = DocumentApp.openById(tmpFile.getId());
  replaceAllPlaceholders_(doc, data);

  const body = doc.getBody();
  const table = findMainTable_(body);
  if (!table) throw new Error('Não encontrei a tabela principal no template.');

  const rowsMap = [
    { label: 'Funilaria', statusCol: 'Funilaria', costCol: 'Custo Funilaria', obsCol: 'Descreva as peças de funilaria' },
    { label: 'Tapeçaria', statusCol: 'Tapeçaria', costCol: 'Custo Tapeçaria', obsCol: 'Descreva Tapeçaria' },
    { label: 'Elétrica', statusCol: 'Elétrica', costCol: 'Custo Elétrica', obsCol: 'Descrição da Elétrica' },
    { label: 'Mecânica', statusCol: 'Mecânica', costCol: 'Custo Mecânica', obsCol: 'Descrição da Mecânica' },
    { label: 'Suspensão', statusCol: 'Suspensão', costCol: 'Custo Suspensão', obsCol: 'Descrição da Suspensão' },
    { label: 'Pneus Dianteiros', statusCol: 'Pneus Dianteiros', costCol: 'Custo Pneus dianteiros', obsCol: 'Descrição sobre os Pneus' },
    { label: 'Pneus Traseiros', statusCol: 'Pneus Traseiros', costCol: 'Custo Pneus Traseiros', obsCol: 'Descrição Pneus Traseiros' },
    { label: 'Vidros', statusCol: 'Vidros', costCol: 'Custo dos Vidros', obsCol: 'Descrição dos Vidros' },
    { label: 'Ferramentas', statusCol: 'Ferramentas', costCol: 'Custo Ferramentas', obsCol: 'Descrição de Ferramentas' },
    { label: 'Estepe', statusCol: 'Estepe', costCol: 'Custo Estepe', obsCol: 'Descrição sobre o Estepe' },
    { label: 'Ar condicionado', statusCol: 'Ar condicionado', costCol: 'Custo do Ar Condicionado', obsCol: 'Descrição sobre o Ar Condicionado' },
    { label: 'Lavagem', statusCol: 'Lavagem', costCol: 'Custo da Lavagem', obsCol: 'Descrição da Lavagem' }
  ];

  for (let i = 0; i < rowsMap.length; i++) {
    const r = i + 1;
    if (r >= table.getNumRows()) break;

    const m = rowsMap[i];
    const nota = String(data[m.statusCol] || 'BOM').toUpperCase();
    const gastos = brlFromInt_(data[m.costCol] || 0);
    const obs = String(data[m.obsCol] || '');

    safeSetCellText_(table, r, 0, m.label);
    safeSetCellText_(table, r, 1, nota);
    safeSetCellText_(table, r, 2, gastos);
    safeSetCellText_(table, r, 3, obs);
    safeSetCellText_(table, r, 4, (m.label === 'Suspensão') ? multilineList_(data['Opcionais']) : '');
  }

  doc.saveAndClose();

  const pdfBlob = DriveApp.getFileById(tmpFile.getId()).getBlob().getAs('application/pdf');
  const finalName = `Ficha_${placa}_${cliente}_${stamp}.pdf`;
  const pdfFile = folder.createFile(pdfBlob).setName(finalName);

  DriveApp.getFileById(tmpFile.getId()).setTrashed(true);

  return pdfFile;
}

// ===== PLACEHOLDERS =====
function replaceAllPlaceholders_(doc, data) {
  const sections = [doc.getBody(), doc.getHeader(), doc.getFooter()].filter(Boolean);

  sections.forEach(sec => {
    Object.keys(data).forEach(keyRaw => {
      const key = String(keyRaw || '').trim();
      if (!key) return;

      const ph = `{{${key}}}`;

      let value = data[keyRaw];
      if (value === undefined) value = data[key];

      if (
        key === 'Valor Total da Ficha' ||
        key === 'Valor do Precificador' ||
        key === 'Valor da Fipe' ||
        key === 'Valor do débitos de multa'
      ) {
        value = brlFromInt_(value);
      }

      if (key === 'Carimbo de data/hora' || key === 'Data e Hora') {
        value = Utilities.formatDate(
          new Date(value),
          Session.getScriptTimeZone(),
          'dd/MM/yyyy HH:mm'
        );
      }

      let s = String(value ?? '');

      if (key === 'Opcionais' || key === 'Avaliacao') {
        s = inlineCommaList_(s);
      }

      sec.replaceText(escapeForDocsRegex_(ph), s);
    });
  });
}

function inlineCommaList_(s) {
  return String(s || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function multilineList_(s) {
  return String(s || '').replace(/,\s*/g, '\n').trim();
}

function brlFromInt_(v) {
  const n = Number(String(v ?? '0').replace(/[^\d]/g, '')) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR');
}

function safeSetCellText_(table, row, col, text) {
  if (col >= table.getRow(row).getNumCells()) return;
  const cell = table.getCell(row, col);
  cell.clear();
  cell.setText(String(text || ''));
}

function escapeForDocsRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMainTable_(body) {
  const tables = body.getTables();
  for (const t of tables) {
    if (t.getNumRows() === 0) continue;
    const headerRow = t.getRow(0);
    const headerText = headerRow.getText().toLowerCase();
    if (headerText.includes('conserv') && headerText.includes('nota') && headerText.includes('gasto')) {
      return t;
    }
  }
  return null;
}

// ===== EMAIL CONFIG / ADMIN =====
function ensureEmailSettings_() {
  const props = PropertiesService.getScriptProperties();

  if (!props.getProperty(PROP_ADMIN_PASSWORD)) {
    props.setProperty(PROP_ADMIN_PASSWORD, '123456');
  }

  if (!props.getProperty(PROP_EMAIL_SETTINGS)) {
    const defaults = {
      testMode: true,
      adminEmail: getAppConfig_().testEmailTo,
      leaderEmail: '',
      analistas: {},
      avaliadores: {}
    };
    props.setProperty(PROP_EMAIL_SETTINGS, JSON.stringify(defaults));
  }
}

function getEmailSettings_() {
  ensureEmailSettings_();
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_EMAIL_SETTINGS);
  return JSON.parse(raw || '{}');
}

function saveEmailSettings_(obj) {
  PropertiesService.getScriptProperties().setProperty(PROP_EMAIL_SETTINGS, JSON.stringify(obj));
}

function normalizeKey_(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function verifyAdminPassword(password) {
  ensureEmailSettings_();
  const saved = PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_PASSWORD) || '';
  return { ok: String(password || '') === String(saved) };
}

function setAdminPassword(currentPassword, newPassword) {
  ensureEmailSettings_();
  const saved = PropertiesService.getScriptProperties().getProperty(PROP_ADMIN_PASSWORD) || '';
  if (String(currentPassword || '') !== String(saved)) {
    throw new Error('Senha atual inválida.');
  }
  const np = String(newPassword || '').trim();
  if (np.length < 4) {
    throw new Error('A nova senha deve ter pelo menos 4 caracteres.');
  }
  PropertiesService.getScriptProperties().setProperty(PROP_ADMIN_PASSWORD, np);
  return { ok: true };
}

function getEmailRoutingSettings(password) {
  const check = verifyAdminPassword(password);
  if (!check.ok) throw new Error('Senha inválida.');

  return {
    ok: true,
    settings: getEmailSettings_()
  };
}

function saveEmailRoutingSettings(password, settings) {
  const check = verifyAdminPassword(password);
  if (!check.ok) throw new Error('Senha inválida.');

  const clean = {
    testMode: !!settings?.testMode,
    adminEmail: String(settings?.adminEmail || '').trim(),
    leaderEmail: String(settings?.leaderEmail || '').trim(),
    analistas: normalizeRoutingMap_(settings?.analistas || {}),
    avaliadores: normalizeRoutingMap_(settings?.avaliadores || {})
  };

  if (!clean.adminEmail) {
    throw new Error('Informe o e-mail do administrador.');
  }

  saveEmailSettings_(clean);
  return { ok: true, settings: clean };
}

function normalizeRoutingMap_(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(name => {
    const email = String(obj[name] || '').trim();
    if (email) out[name] = email;
  });
  return out;
}

function resolveRecipients_(data) {
  const cfg = getEmailSettings_();
  const adminEmail = String(cfg.adminEmail || getAppConfig_().testEmailTo).trim();

  if (cfg.testMode) {
    return [adminEmail];
  }

  const set = new Set();
  if (adminEmail) set.add(adminEmail);
  if (cfg.leaderEmail) set.add(String(cfg.leaderEmail).trim());

  const analistaNome = String(data['Analista'] || '').trim();
  const avaliadorNome = String(data['Avaliador'] || '').trim();

  const analistaEmail = findMappedEmail_(cfg.analistas || {}, analistaNome);
  const avaliadorEmail = findMappedEmail_(cfg.avaliadores || {}, avaliadorNome);

  if (analistaEmail) set.add(analistaEmail);
  if (avaliadorEmail) set.add(avaliadorEmail);

  return Array.from(set).filter(Boolean);
}

function findMappedEmail_(map, name) {
  const key = normalizeKey_(name);
  if (!key) return '';

  let exact = '';
  Object.keys(map || {}).forEach(k => {
    if (normalizeKey_(k) === key) exact = String(map[k] || '').trim();
  });
  return exact;
}

// ===== EMAIL BODY / SUBJECT =====
function buildEmailSubject_(data) {
  const avaliador = sanitizeSubjectPart_(data['Avaliador']);
  const veiculo = sanitizeSubjectPart_(`${data['Marca do Veículo'] || ''}_${data['Modelo e versão'] || ''}`);
  const placa = sanitizeSubjectPart_(data['Placa']);
  const analista = sanitizeSubjectPart_(data['Analista']);
  const valorFipe = sanitizeSubjectPart_(brlFromInt_(data['Valor da Fipe']));
  const valorPrec = sanitizeSubjectPart_(brlFromInt_(data['Valor do Precificador']));
  const valorFicha = sanitizeSubjectPart_(brlFromInt_(data['Valor Total da Ficha']));

  return `Ficha de Avaliação - ${avaliador}_${veiculo}_${placa}_${analista}_${valorFipe}_${valorPrec}_${valorFicha}`;
}

function sanitizeSubjectPart_(s) {
  return String(s || '')
    .replace(/\s+/g, '_')
    .replace(/[^\wÀ-ÿ$.,-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sendEmailFromRow_(data, pdfFile, originalPayload) {
  const subject = buildEmailSubject_(data);
  const recipients = resolveRecipients_(data);

  const htmlBody = buildEmailHtml_(data, originalPayload, pdfFile, recipients);
  const bodyText = buildEmailText_(data, pdfFile, recipients, originalPayload);

  MailApp.sendEmail({
    to: recipients.join(','),
    subject,
    body: bodyText,
    htmlBody,
    attachments: [pdfFile.getBlob()]
  });
}

function buildEmailText_(data, pdfFile, recipients, originalPayload) {
  const sections = buildSectionsSummaryFromPayload_(originalPayload, data);
  const lines = [];
  lines.push('Ficha de Avaliação');
  lines.push('');
  lines.push(`Destinatários: ${recipients.join(', ')}`);
  lines.push(`Cliente: ${data['Cliente'] || ''}`);
  lines.push(`Placa: ${data['Placa'] || ''}`);
  lines.push(`Marca/Modelo: ${(data['Marca do Veículo'] || '')} ${(data['Modelo e versão'] || '')}`);
  lines.push(`Versão: ${data['Versão'] || ''}`);
  lines.push(`Analista: ${data['Analista'] || ''}`);
  lines.push(`Avaliador: ${data['Avaliador'] || ''}`);
  lines.push('');
  lines.push(`Valor Total da Ficha: ${brlFromInt_(data['Valor Total da Ficha'])}`);
  lines.push(`Valor do Precificador: ${brlFromInt_(data['Valor do Precificador'])}`);
  lines.push(`Valor da Fipe: ${brlFromInt_(data['Valor da Fipe'])}`);
  lines.push(`Débitos de multa: ${brlFromInt_(data['Valor do débitos de multa'])}`);
  lines.push('');

  if (sections.length) {
    lines.push('Seções apontadas:');
    sections.forEach(s => {
      lines.push(`- ${s.label}: ${s.details} | Valor: ${s.value}`);
    });
    lines.push('');
  }

  lines.push(`PDF: ${pdfFile.getUrl()}`);
  return lines.join('\n');
}

function buildEmailHtml_(data, originalPayload, pdfFile, recipients) {
  const sections = buildSectionsSummaryFromPayload_(originalPayload, data);

  const basicRows = [
    ['Avaliador', data['Avaliador']],
    ['Analista', data['Analista']],
    ['Data e Hora', formatDateMaybe_(data['Data e Hora'])],
    ['Cliente', data['Cliente']],
    ['Celular', data['Celular']],
    ['Email', data['Email']],
    ['Placa', data['Placa']],
    ['Marca do Veículo', data['Marca do Veículo']],
    ['Modelo e versão', data['Modelo e versão']],
    ['Versão', data['Versão']],
    ['Ano/Modelo', data['Ano/Modelo']],
    ['Cor', data['Cor']],
    ['KM Atual', data['KM Atual']]
  ];

  const fechamentoRows = [
    ['Valor Total da Ficha', brlFromInt_(data['Valor Total da Ficha'])],
    ['Valor do Precificador', brlFromInt_(data['Valor do Precificador'])],
    ['Valor da Fipe', brlFromInt_(data['Valor da Fipe'])],
    ['Débitos de multa', brlFromInt_(data['Valor do débitos de multa'])],
    ['Possui quitação', data['Possui quitação']],
    ['Quanto cliente quer?', data['Quanto cliente quer ? (oriente a ele que normalmente é precificador menos ficha)']],
    ['Observações Relevantes', data['Observações Relevantes']],
    ['Opcionais', data['Opcionais']],
    ['Avaliações', data['Avaliacao']]
  ];

  const sectionsHtml = sections.length
    ? sections.map(s => `
        <div style="border:1px solid #eee;border-radius:10px;padding:10px;margin-bottom:10px">
          <div style="font-weight:700">${escapeHtml_(s.label)} - ${escapeHtml_(s.status)}</div>
          <div><b>Itens:</b> ${escapeHtml_(s.details)}</div>
          <div><b>Valor:</b> ${escapeHtml_(s.value)}</div>
        </div>
      `).join('')
    : `<div style="color:#666">Sem seções apontadas.</div>`;

  return `
  <div style="font-family:Arial,sans-serif;color:#111;line-height:1.5">
    <h2 style="margin:0 0 12px">Ficha de Avaliação</h2>
    <p style="margin:0 0 14px"><b>Destinatários:</b> ${escapeHtml_(recipients.join(', '))}</p>

    <div style="border:1px solid #e7e7e7;border-radius:12px;padding:14px;margin-bottom:14px">
      <h3 style="margin:0 0 10px">Dados básicos</h3>
      ${buildHtmlRows_(basicRows)}
    </div>

    <div style="border:1px solid #e7e7e7;border-radius:12px;padding:14px;margin-bottom:14px">
      <h3 style="margin:0 0 10px">Seções apontadas</h3>
      ${sectionsHtml}
    </div>

    <div style="border:1px solid #e7e7e7;border-radius:12px;padding:14px;margin-bottom:14px">
      <h3 style="margin:0 0 10px">Fechamento</h3>
      ${buildHtmlRows_(fechamentoRows)}
    </div>

    <p style="margin-top:18px"><b>PDF:</b> <a href="${pdfFile.getUrl()}">Abrir no Drive</a></p>
  </div>`;
}

function buildHtmlRows_(rows) {
  return rows.map(([label, value]) => `
    <div style="margin:6px 0">
      <span style="font-weight:700">${escapeHtml_(label)}:</span>
      <span>${escapeHtml_(String(value || '—'))}</span>
    </div>
  `).join('');
}

function buildSectionsSummaryFromPayload_(payload, data) {
  const defs = [
    ['funilaria', 'Funilaria', 'Descreva as peças de funilaria', 'Custo Funilaria'],
    ['tapecaria', 'Tapeçaria', 'Descreva Tapeçaria', 'Custo Tapeçaria'],
    ['eletrica', 'Elétrica', 'Descrição da Elétrica', 'Custo Elétrica'],
    ['mecanica', 'Mecânica', 'Descrição da Mecânica', 'Custo Mecânica'],
    ['suspensao', 'Suspensão', 'Descrição da Suspensão', 'Custo Suspensão'],
    ['pneusDianteiros', 'Pneus Dianteiros', 'Descrição sobre os Pneus', 'Custo Pneus dianteiros'],
    ['pneusTraseiros', 'Pneus Traseiros', 'Descrição Pneus Traseiros', 'Custo Pneus Traseiros'],
    ['vidros', 'Vidros', 'Descrição dos Vidros', 'Custo dos Vidros'],
    ['ferramentas', 'Ferramentas', 'Descrição de Ferramentas', 'Custo Ferramentas'],
    ['estepe', 'Estepe', 'Descrição sobre o Estepe', 'Custo Estepe'],
    ['arCondicionado', 'Ar condicionado', 'Descrição sobre o Ar Condicionado', 'Custo do Ar Condicionado'],
    ['lavagem', 'Lavagem', 'Descrição da Lavagem', 'Custo da Lavagem']
  ];

  const rows = defs.map(([key, label, descCol, valCol]) => {
    const s = payload?.secoes?.[key];

    if (s) {
      if (!s.tem) return null;

      const list = [];
      (s.itens || []).forEach(x => {
        if (!String(x || '').toLowerCase().startsWith('outro')) list.push(String(x));
      });
      if (s.outro) list.push(String(s.outro));

      return {
        label,
        status: 'RUIM',
        details: list.length ? list.join(', ').toLowerCase() : 'sem itens detalhados',
        value: brlFromInt_(s.valor || 0)
      };
    }

    const status = String(data[label] || '').toUpperCase();
    if (status !== 'RUIM') return null;

    const rawDesc = String(data[descCol] || '').trim();
    const details = rawDesc ? rawDesc.toLowerCase() : 'sem itens detalhados';

    return {
      label,
      status: 'RUIM',
      details,
      value: brlFromInt_(data[valCol] || 0)
    };
  });

  return rows.filter(Boolean);
}

function formatDateMaybe_(v) {
  try {
    if (!v) return '';
    return Utilities.formatDate(new Date(v), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  } catch (e) {
    return String(v || '');
  }
}

function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ===== SETUP CABEÇALHOS =====
function setupFichasHeaders() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName(SHEET_FICHAS);

  const headers = [
    'Carimbo de data/hora','ID','VersaoApp',
    'Avaliador','Analista','Data e Hora','Cliente','Celular','Email',
    'Placa','Marca do Veículo','Modelo e versão','Versão','Ano/Modelo','Cor','KM Atual',
    'Funilaria','Custo Funilaria','Descreva as peças de funilaria',
    'Tapeçaria','Custo Tapeçaria','Descreva Tapeçaria',
    'Elétrica','Custo Elétrica','Descrição da Elétrica',
    'Mecânica','Custo Mecânica','Descrição da Mecânica',
    'Suspensão','Custo Suspensão','Descrição da Suspensão',
    'Pneus Dianteiros','Custo Pneus dianteiros','Descrição sobre os Pneus',
    'Pneus Traseiros','Custo Pneus Traseiros','Descrição Pneus Traseiros',
    'Vidros','Custo dos Vidros','Descrição dos Vidros',
    'Ferramentas','Custo Ferramentas','Descrição de Ferramentas',
    'Estepe','Custo Estepe','Descrição sobre o Estepe',
    'Ar condicionado','Custo do Ar Condicionado','Descrição sobre o Ar Condicionado',
    'Lavagem','Custo da Lavagem','Descrição da Lavagem',
    'Opcionais','Avaliacao',
    'Valor Total da Ficha','Valor do Precificador','Valor da Fipe','Valor do débitos de multa',
    'Possui quitação','Quanto cliente quer ? (oriente a ele que normalmente é precificador menos ficha)',
    'Observações Relevantes',
    'Status','UltimoErro','PDF_URL','EnviadoEm'
  ];

  sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).clearContent();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
}

// ===== LAB / AMBIENTE =====
function getEnvironmentDiagnostics() {
  const cfg = getAppConfig_();
  const out = {
    ok: true,
    env: cfg.env,
    isLab: cfg.isLab,
    spreadsheetId: cfg.spreadsheetId,
    pdfFolderId: cfg.pdfFolderId,
    docTemplateId: cfg.docTemplateId,
    testEmailTo: cfg.testEmailTo,
    appVersion: APP_VERSION,
    currentScriptId: getCurrentScriptId_(),
    spreadsheetName: '',
    sheets: [],
    pdfFolderName: '',
    docTemplateName: '',
    emailSettings: null
  };

  try {
    const ss = getSpreadsheet_();
    out.spreadsheetName = ss.getName();
    out.sheets = ss.getSheets().map(s => s.getName());
  } catch (e) {
    out.spreadsheetError = String(e && e.message ? e.message : e);
  }

  try {
    out.pdfFolderName = DriveApp.getFolderById(cfg.pdfFolderId).getName();
  } catch (e) {
    out.pdfFolderError = String(e && e.message ? e.message : e);
  }

  try {
    out.docTemplateName = DriveApp.getFileById(cfg.docTemplateId).getName();
  } catch (e) {
    out.docTemplateError = String(e && e.message ? e.message : e);
  }

  try {
    out.emailSettings = getEmailSettings_();
  } catch (e) {
    out.emailSettingsError = String(e && e.message ? e.message : e);
  }

  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function createLabCopiesFromCurrentConfig() {
  const cfg = getAppConfig_();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
  const root = DriveApp.createFolder(`Ficha Mecânica LAB ${stamp}`);
  const pdfFolder = root.createFolder('PDFs LAB');

  const spreadsheetCopy = DriveApp
    .getFileById(cfg.spreadsheetId)
    .makeCopy(`Ficha Mecânica LAB ${stamp}`, root);

  const templateCopy = DriveApp
    .getFileById(cfg.docTemplateId)
    .makeCopy(`Template Ficha Mecânica LAB ${stamp}`, root);

  const out = {
    ok: true,
    message: 'Cópias LAB criadas. Use estes IDs no projeto Apps Script LAB.',
    rootFolderId: root.getId(),
    spreadsheetId: spreadsheetCopy.getId(),
    pdfFolderId: pdfFolder.getId(),
    docTemplateId: templateCopy.getId()
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function createAndConfigureLabFromCurrentConfig() {
  if (getCurrentScriptId_() === DEFAULT_PROD_SCRIPT_ID) {
    throw new Error('Segurança: não execute esta função no projeto operacional. Use o Apps Script LAB.');
  }

  const ids = createLabCopiesFromCurrentConfig();
  const out = configureLabEnvironment({
    spreadsheetId: ids.spreadsheetId,
    pdfFolderId: ids.pdfFolderId,
    docTemplateId: ids.docTemplateId,
    testEmailTo: getAppConfig_().testEmailTo
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

function configureLabEnvironment(config) {
  if (getCurrentScriptId_() === DEFAULT_PROD_SCRIPT_ID) {
    throw new Error('Segurança: não configure o projeto operacional como LAB.');
  }

  const spreadsheetId = String(config?.spreadsheetId || '').trim();
  const pdfFolderId = String(config?.pdfFolderId || '').trim();
  const docTemplateId = String(config?.docTemplateId || '').trim();
  const testEmailTo = String(config?.testEmailTo || DEFAULT_TEST_EMAIL_TO).trim();

  if (!spreadsheetId) throw new Error('Informe spreadsheetId para configurar o LAB.');
  if (!pdfFolderId) throw new Error('Informe pdfFolderId para configurar o LAB.');
  if (!docTemplateId) throw new Error('Informe docTemplateId para configurar o LAB.');

  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_APP_ENV, 'LAB');
  props.setProperty(PROP_SPREADSHEET_ID, spreadsheetId);
  props.setProperty(PROP_PDF_FOLDER_ID, pdfFolderId);
  props.setProperty(PROP_DOC_TEMPLATE_ID, docTemplateId);
  props.setProperty(PROP_TEST_EMAIL_TO, testEmailTo);

  saveEmailSettings_({
    testMode: true,
    adminEmail: testEmailTo,
    leaderEmail: '',
    analistas: {},
    avaliadores: {}
  });
  clearCatalogsCache_();

  const out = getEnvironmentDiagnostics();
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

// ===== AUTORIZAÇÃO =====
function authorizeNow() {
  const cfg = getAppConfig_();
  DriveApp.getFolderById(cfg.pdfFolderId).getName();
  DocumentApp.openById(cfg.docTemplateId).getBody().getText();
  MailApp.sendEmail(cfg.testEmailTo, "Auth Test", "ok");
  UrlFetchApp.fetch('https://api.tonyveiculos.com.br', { muteHttpExceptions: true });
}

// ===== SETUP ADMIN =====
function setupDefaultAdminConfig() {
  PropertiesService.getScriptProperties().setProperty(PROP_ADMIN_PASSWORD, '123456');
  saveEmailSettings_({
    testMode: true,
    adminEmail: getAppConfig_().testEmailTo,
    leaderEmail: '',
    analistas: {},
    avaliadores: {}
  });
  return 'Configuração padrão criada com sucesso.';
}

// ===== TESTES MANUAIS =====
function testarConsultaPlacaFichaTonyInfocar() {
  const r = suggestVehicleFieldsFromPlate({ placa: 'FML6G64' });
  Logger.log(JSON.stringify(r, null, 2));
}

function testarConsultaPlacaFichaTiggo() {
  const r = suggestVehicleFieldsFromPlate({ placa: 'RCG6B95' });
  Logger.log(JSON.stringify(r, null, 2));
}
