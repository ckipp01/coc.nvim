/*tslint:disable*/
import {
  createConnection,
  IConnection,
  TextDocuments,
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver'
import {TextDocument} from 'vscode-languageserver-types'
import {
  getCSSLanguageService,
  getSCSSLanguageService,
  getLESSLanguageService,
  LanguageSettings,
  LanguageService,
  Stylesheet
} from 'vscode-css-languageservice'
import {getLanguageModelCache} from './languageModelCache'
import {convertCompleteItems} from './utils/convert'
import {formatError, runSafe} from './utils/runner'

export interface Settings {
  css: LanguageSettings
  less: LanguageSettings
  scss: LanguageSettings
}

// Create a connection for the server.
const connection: IConnection = createConnection()

console.log = connection.console.log.bind(connection.console)
console.error = connection.console.error.bind(connection.console)

process.on('unhandledRejection', (e: any) => {
  connection.console.error(formatError(`Unhandled exception`, e))
})

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents: TextDocuments = new TextDocuments()
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection)

const stylesheets = getLanguageModelCache<Stylesheet>(10, 60, document =>
  getLanguageService(document).parseStylesheet(document)
)
documents.onDidClose(e => {
  stylesheets.onDocumentRemoved(e.document)
})
connection.onShutdown(() => {
  stylesheets.dispose()
})

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((params: InitializeParams): InitializeResult => {

  function getClientCapability<T>(name: string, def: T) {
    const keys = name.split('.')
    let c: any = params.capabilities
    for (let i = 0; c && i < keys.length; i++) {
      if (!c.hasOwnProperty(keys[i])) {
        return def
      }
      c = c[keys[i]]
    }
    return c
  }
  const snippetSupport = !!getClientCapability(
    'textDocument.completion.completionItem.snippetSupport',
    false
  )

  const capabilities: ServerCapabilities = {
    // Tell the client that the server works in FULL text document sync mode
    textDocumentSync: documents.syncKind,
    completionProvider: snippetSupport
      ? {resolveProvider: false, triggerCharacters: [':']}
      : undefined,
    hoverProvider: true,
    documentSymbolProvider: true,
    referencesProvider: true,
    definitionProvider: true,
    documentHighlightProvider: true,
    codeActionProvider: true,
    renameProvider: true,
    colorProvider: {},
  }
  return {capabilities}
})

const languageServices: {[id: string]: LanguageService} = {
  css: getCSSLanguageService(),
  scss: getSCSSLanguageService(),
  less: getLESSLanguageService()
}

function getLanguageService(document: TextDocument) {
  let service = languageServices[document.languageId]
  if (!service) {
    connection.console.log(
      'Document type is ' + document.languageId + ', using css instead.'
    )
    service = languageServices['css']
  }
  return service
}

let documentSettings: {
  [key: string]: Thenable<LanguageSettings | undefined>
} = {}

// remove document settings on close
documents.onDidClose(e => {
  delete documentSettings[e.document.uri]
})

function getDocumentSettings(textDocument: TextDocument): Thenable<LanguageSettings | undefined> {
  return Promise.resolve(void 0)
}

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration(change => {
  updateConfiguration(<Settings>change.settings)
})

function updateConfiguration(settings: Settings) {
  for (const languageId in languageServices) {
    languageServices[languageId].configure((settings as any)[languageId])
  }
  // reset all document settings
  documentSettings = {}
  // Revalidate any open text documents
  documents.all().forEach(triggerValidation)
}

const pendingValidationRequests: {[uri: string]: NodeJS.Timer} = {}
const validationDelayMs = 200

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
  triggerValidation(change.document)
})

// a document has closed: clear all diagnostics
documents.onDidClose(event => {
  cleanPendingValidation(event.document)
  connection.sendDiagnostics({uri: event.document.uri, diagnostics: []})
})

function cleanPendingValidation(textDocument: TextDocument): void {
  const request = pendingValidationRequests[textDocument.uri]
  if (request) {
    clearTimeout(request)
    delete pendingValidationRequests[textDocument.uri]
  }
}

function triggerValidation(textDocument: TextDocument): void {
  cleanPendingValidation(textDocument)
  pendingValidationRequests[textDocument.uri] = setTimeout(() => {
    delete pendingValidationRequests[textDocument.uri]
    validateTextDocument(textDocument)
  }, validationDelayMs)
}

function validateTextDocument(textDocument: TextDocument): void {
  const settingsPromise = getDocumentSettings(textDocument)
  settingsPromise.then(
    settings => {
      const stylesheet = stylesheets.get(textDocument)
      const diagnostics = getLanguageService(textDocument).doValidation(
        textDocument,
        stylesheet,
        settings
      )
      // Send the computed diagnostics to VSCode.
      connection.sendDiagnostics({uri: textDocument.uri, diagnostics})
    },
    e => {
      connection.console.error(
        formatError(`Error while validating ${textDocument.uri}`, e)
      )
    }
  )
}

connection.onCompletion((textDocumentPosition, token) => {
  return runSafe(
    () => {
      const document = documents.get(textDocumentPosition.textDocument.uri)
      if (!document) {
        return null
      }
      const cssLS = getLanguageService(document)
      const result = cssLS.doComplete(
        document,
        textDocumentPosition.position,
        stylesheets.get(document)
      )
      return {
        isIncomplete: false,
        items: convertCompleteItems(result.items)
      }
    },
    null,
    `Error while computing completions for ${
      textDocumentPosition.textDocument.uri
    }`,
    token
  )
})

connection.onHover((textDocumentPosition, token) => {
  return runSafe(
    () => {
      const document = documents.get(textDocumentPosition.textDocument.uri)
      if (document) {
        const styleSheet = stylesheets.get(document)
        return getLanguageService(document).doHover(
          document,
          textDocumentPosition.position,
          styleSheet
        )
      }
      return null
    },
    null,
    `Error while computing hover for ${textDocumentPosition.textDocument.uri}`,
    token
  )
})

connection.onDocumentSymbol((documentSymbolParams, token) => {
  return runSafe(
    () => {
      const document = documents.get(documentSymbolParams.textDocument.uri)
      if (document) {
        const stylesheet = stylesheets.get(document)
        return getLanguageService(document).findDocumentSymbols(
          document,
          stylesheet
        )
      }
      return []
    },
    [],
    `Error while computing document symbols for ${
      documentSymbolParams.textDocument.uri
    }`,
    token
  )
})

connection.onDefinition((documentSymbolParams, token) => {
  return runSafe(
    () => {
      const document = documents.get(documentSymbolParams.textDocument.uri)
      if (document) {
        const stylesheet = stylesheets.get(document)
        return getLanguageService(document).findDefinition(
          document,
          documentSymbolParams.position,
          stylesheet
        )
      }
      return null
    },
    null,
    `Error while computing definitions for ${
      documentSymbolParams.textDocument.uri
    }`,
    token
  )
})

connection.onDocumentHighlight((documentSymbolParams, token) => {
  return runSafe(
    () => {
      const document = documents.get(documentSymbolParams.textDocument.uri)
      if (document) {
        const stylesheet = stylesheets.get(document)
        return getLanguageService(document).findDocumentHighlights(
          document,
          documentSymbolParams.position,
          stylesheet
        )
      }
      return []
    },
    [],
    `Error while computing document highlights for ${
      documentSymbolParams.textDocument.uri
    }`,
    token
  )
})

connection.onReferences((referenceParams, token) => {
  return runSafe(
    () => {
      const document = documents.get(referenceParams.textDocument.uri)
      if (document) {
        const stylesheet = stylesheets.get(document)
        return getLanguageService(document).findReferences(
          document,
          referenceParams.position,
          stylesheet
        )
      }
      return []
    },
    [],
    `Error while computing references for ${referenceParams.textDocument.uri}`,
    token
  )
})

connection.onCodeAction((codeActionParams, token) => {
  return runSafe(
    () => {
      const document = documents.get(codeActionParams.textDocument.uri)
      if (document) {
        const stylesheet = stylesheets.get(document)
        return getLanguageService(document).doCodeActions(
          document,
          codeActionParams.range,
          codeActionParams.context,
          stylesheet
        )
      }
      return []
    },
    [],
    `Error while computing code actions for ${
      codeActionParams.textDocument.uri
    }`,
    token
  )
})

connection.onRenameRequest((renameParameters, token) => {
  return runSafe(
    () => {
      const document = documents.get(renameParameters.textDocument.uri)
      if (document) {
        const stylesheet = stylesheets.get(document)
        return getLanguageService(document).doRename(
          document,
          renameParameters.position,
          renameParameters.newName,
          stylesheet
        )
      }
      return null
    },
    null,
    `Error while computing renames for ${renameParameters.textDocument.uri}`,
    token
  )
})

// Listen on the connection
connection.listen()
