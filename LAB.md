# Laboratório da Ficha Mecânica

Este projeto é o carro-chefe operacional. A regra é simples: nenhuma melhoria deve ser validada diretamente no ambiente de produção.

## Ambientes

Produção usa os IDs padrão que já existiam no código:

- Planilha: `10u4arnqwIH4_W-pwMrYBT6FunZopw0eLj2gl_MfE1QA`
- Pasta PDF: `1YPyBpBWjKDBH_sl-Q4KTYp6sOKfnE1a_`
- Template Docs: `1ZTzPhHyEI7dFpgb5yOIFJ190bRr1FJS6moOpjX9eMLI`

O LAB deve usar IDs próprios via Script Properties:

- `APP_ENV`: `LAB`
- `SPREADSHEET_ID`: ID da planilha LAB
- `PDF_FOLDER_ID`: ID da pasta de PDFs LAB
- `DOC_TEMPLATE_ID`: ID do template Docs LAB
- `TEST_EMAIL_TO`: e-mail que recebe os testes
- `TOKEN_API`: token da API Tony/Infocar

Se essas propriedades não existirem, o app continua usando os IDs de produção. Isso preserva o comportamento atual.

## Fluxo Seguro

1. Trabalhar sempre na branch `lab/mobile-first`.
2. Criar cópias LAB da planilha, da pasta PDF e do template.
3. Criar ou usar um projeto Apps Script separado para o LAB.
4. Configurar as Script Properties do LAB.
5. Publicar o Web App LAB.
6. Testar no celular real.
7. Só depois promover as mudanças para `main` e publicar na produção.

## Funções de Apoio

No Apps Script, existem funções manuais para ajudar:

- `createLabCopiesFromCurrentConfig()`: cria cópias da planilha e template atuais, além de uma pasta de PDFs LAB. Retorna os IDs para configurar o LAB.
- `configureLabEnvironment(config)`: configura um projeto Apps Script como LAB usando IDs informados.
- `getEnvironmentDiagnostics()`: mostra para onde o app está apontando, nomes dos arquivos/pastas e configurações principais.

Exemplo para configurar o LAB no editor Apps Script:

```js
configureLabEnvironment({
  spreadsheetId: 'ID_DA_PLANILHA_LAB',
  pdfFolderId: 'ID_DA_PASTA_PDF_LAB',
  docTemplateId: 'ID_DO_TEMPLATE_LAB',
  testEmailTo: 'cristianotonyveiculos@gmail.com'
});
```

Depois rode:

```js
getEnvironmentDiagnostics();
```

Confirme que `env` é `LAB` e que os nomes dos arquivos são os do laboratório.

## Checklist de Teste Mobile

- Abrir o Web App LAB no celular.
- Confirmar faixa amarela `AMBIENTE DE TESTE - LAB`.
- Carregar avaliadores e analistas.
- Digitar placa válida e confirmar preenchimento automático.
- Testar uma placa não encontrada e preenchimento manual.
- Marcar uma seção como `Não`.
- Marcar uma seção como `Sim`, escolher item, valor e salvar.
- Testar item `Outro` sem descrição e com descrição.
- Validar cálculo do valor total.
- Ir para revisão e conferir todos os dados.
- Enviar ficha.
- Confirmar linha nova na planilha LAB.
- Confirmar PDF gerado na pasta LAB.
- Confirmar e-mail recebido apenas no e-mail de teste.

