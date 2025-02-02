import { getErrorPageId, getAllPageIds, route, isErrorPage, loadPageRoutes, PageRoutes } from '../shared/route'
import { HtmlRender, isDocumentHtml, renderHtml, getHtmlString } from './html/renderHtml'
import { AllPageFiles, getAllPageFiles, findPageFile, findDefaultFiles, findDefaultFile } from '../shared/getPageFiles'
import { getSsrEnv } from './ssrEnv'
import { stringify } from '@brillout/json-s'
import {
  assert,
  assertUsage,
  isCallable,
  assertWarning,
  hasProp,
  handlePageContextRequestSuffix,
  isPlainObject,
  isObject,
  UrlParsed,
  objectAssign,
  PromiseType,
  compareString,
  assertExports,
  stringifyStringArray,
  handleUrlOrigin
} from '../shared/utils'
import { analyzeBaseUrl } from './baseUrlHandling'
import { getPageAssets, PageAssets } from './html/injectAssets'
import { loadPageMainFiles, PageMainFile, PageMainFileDefault } from '../shared/loadPageMainFiles'
import { sortPageContext } from '../shared/sortPageContext'
import {
  getStreamReadableNode,
  getStreamReadableWeb,
  pipeToStreamWritableWeb,
  pipeToStreamWritableNode,
  StreamPipeNode,
  StreamPipeWeb,
  StreamReadableNode,
  StreamReadableWeb,
  StreamWritableNode,
  StreamWritableWeb
} from './html/stream'
import { serializePageContextClientSide } from './serializePageContextClientSide'
import { addComputedUrlProps } from '../shared/addComputedurlProps'

export { renderPageWithoutThrowing }
export type { renderPage }
export { prerenderPage }
export { renderStatic404Page }
export { getGlobalContext }
export { loadPageFiles }
export type { GlobalContext }
export { loadOnBeforePrerenderHook }
export { throwPrerenderError }

type PageFiles = PromiseType<ReturnType<typeof loadPageFiles>>
type GlobalContext = PromiseType<ReturnType<typeof getGlobalContext>>

async function renderPage<PageContextAdded extends {}, PageContextInit extends { url: string }>(
  pageContextInit: PageContextInit
): Promise<PageContextInit & (({ httpResponse: HttpResponse } & PageContextAdded) | { httpResponse: null })> {
  assertArguments(...arguments)

  const pageContext = initializePageContext(pageContextInit)

  if ('httpResponse' in pageContext) {
    assert(pageContext.httpResponse === null)
    return pageContext
  }

  const globalContext = await getGlobalContext()
  objectAssign(pageContext, globalContext)

  addComputedUrlProps(pageContext)

  // *** Route ***
  const routeResult = await route(pageContext)
  if ('hookError' in routeResult) {
    return await render500Page<PageContextInit>(pageContextInit, routeResult.hookError)
  }
  objectAssign(pageContext, routeResult.pageContextAddendum)

  // *** Handle 404 ***
  let statusCode: 200 | 404
  if (hasProp(pageContext, '_pageId', 'string')) {
    statusCode = 200
  } else {
    assert(pageContext._pageId === null)
    if (!pageContext._isPageContextRequest) {
      warn404(pageContext)
    }
    const errorPageId = getErrorPageId(pageContext._allPageIds)
    if (!errorPageId) {
      warnMissingErrorPage()
      if (pageContext._isPageContextRequest) {
        const httpResponse = createHttpResponseObject(
          stringify({
            pageContext404PageDoesNotExist: true
          }),
          {
            statusCode: 200,
            renderFilePath: null
          }
        )
        objectAssign(pageContext, { httpResponse })
        return pageContext
      } else {
        const httpResponse = null
        objectAssign(pageContext, { httpResponse })
        return pageContext
      }
    }
    if (!pageContext._isPageContextRequest) {
      statusCode = 404
    } else {
      statusCode = 200
    }
    objectAssign(pageContext, {
      _pageId: errorPageId,
      is404: true
    })
  }

  const pageFiles = await loadPageFiles(pageContext)
  objectAssign(pageContext, pageFiles)

  const hookResult = await executeOnBeforeRenderHook(pageContext)
  if ('hookError' in hookResult) {
    return await render500Page<PageContextInit>(pageContextInit, hookResult.hookError)
  }

  if (pageContext._isPageContextRequest) {
    const pageContextSerialized = serializePageContextClientSide(pageContext, 'json')
    const httpResponse = createHttpResponseObject(pageContextSerialized, { statusCode: 200, renderFilePath: null })
    objectAssign(pageContext, { httpResponse })
    return pageContext
  }

  const renderHookResult = await executeRenderHook(pageContext)

  if ('hookError' in renderHookResult) {
    return await render500Page<PageContextInit>(pageContextInit, renderHookResult.hookError)
  }

  if (renderHookResult === null) {
    objectAssign(pageContext, { httpResponse: null })
    return pageContext
  } else {
    const { htmlRender, renderFilePath } = renderHookResult
    const httpResponse = createHttpResponseObject(htmlRender, { statusCode, renderFilePath })
    objectAssign(pageContext, { httpResponse })
    return pageContext
  }
}

function initializePageContext<PageContextInit extends { url: string }>(pageContextInit: PageContextInit) {
  const pageContext = {
    _isPreRendering: false as const,
    ...pageContextInit
  }

  if (pageContext.url.endsWith('/favicon.ico')) {
    objectAssign(pageContext, { httpResponse: null })
    return pageContext
  }

  const { isPageContextRequest, hasBaseUrl } = analyzeUrl(pageContext.url)
  if (!hasBaseUrl) {
    objectAssign(pageContext, { httpResponse: null })
    return pageContext
  }
  objectAssign(pageContext, {
    _isPageContextRequest: isPageContextRequest
  })

  return pageContext
}

// `renderPageWithoutThrowing()` calls `renderPage()` while ensuring an `err` is always `console.error(err)` instead of `throw err`, so that `vite-plugin-ssr` never triggers a server shut down. (Throwing an error in an Express.js middleware shuts down the whole Express.js server.)
async function renderPageWithoutThrowing(
  pageContextInit: Parameters<typeof renderPage>[0]
): ReturnType<typeof renderPage> {
  const args = arguments as any as Parameters<typeof renderPageWithoutThrowing>
  try {
    return await renderPage.apply(null, args)
  } catch (err) {
    try {
      return await render500Page(pageContextInit, err)
    } catch (_err2) {
      // We swallow `_err2`; logging `err` should be enough; `_err2` is likely the same error than `err` anyways.
      logError(err)
      const pageContext = {}
      objectAssign(pageContext, pageContextInit)
      objectAssign(pageContext, {
        httpResponse: null,
        _err: _err2
      })
      return pageContext
    }
  }
}

async function render500Page<PageContextInit extends { url: string }>(pageContextInit: PageContextInit, err: unknown) {
  logError(err)

  const pageContext = initializePageContext(pageContextInit)
  // `pageContext.httpResponse===null` should have already been handled in `renderPage()`
  assert(!('httpResponse' in pageContext))

  objectAssign(pageContext, { _getUrlNormalized: (url: string) => getUrlNormalized(url) })
  addComputedUrlProps(pageContext)

  objectAssign(pageContext, {
    is404: false,
    _err: err,
    httpResponse: null,
    routeParams: {} as Record<string, string>
  })

  if (pageContext._isPageContextRequest) {
    const body = stringify({
      serverSideError: true
    })
    const httpResponse = createHttpResponseObject(body, { statusCode: 500, renderFilePath: null })
    objectAssign(pageContext, { httpResponse })
    return pageContext
  }

  const allPageFiles = await getAllPageFiles()
  objectAssign(pageContext, {
    _allPageFiles: allPageFiles
  })

  const allPageIds = await getAllPageIds(allPageFiles)
  objectAssign(pageContext, { _allPageIds: allPageIds })

  const errorPageId = getErrorPageId(pageContext._allPageIds)
  if (errorPageId === null) {
    warnMissingErrorPage()
    return pageContext
  }
  objectAssign(pageContext, {
    _pageId: errorPageId
  })

  const pageFiles = await loadPageFiles(pageContext)
  objectAssign(pageContext, pageFiles)

  // We swallow hook errors; another error was already shown to the user in the `logError()` at the beginning of this function; the second error is likely the same than the first error anyways.
  if ('_onBeforeRenderHookCalled' in pageContext) {
    const hookResult = await executeOnBeforeRenderHook(pageContext)
    if ('hookError' in hookResult) {
      warnCouldNotRender500Page(hookResult)
      return pageContext
    }
  }
  const renderHookResult = await executeRenderHook(pageContext)
  if ('hookError' in renderHookResult) {
    warnCouldNotRender500Page(renderHookResult)
    return pageContext
  }

  const { htmlRender, renderFilePath } = renderHookResult
  const httpResponse = createHttpResponseObject(htmlRender, { statusCode: 500, renderFilePath })
  objectAssign(pageContext, { httpResponse })
  return pageContext
}

type HttpResponse = {
  statusCode: 200 | 404 | 500
  body: string
  getBody: () => Promise<string>
  bodyNodeStream: StreamReadableNode
  bodyWebStream: StreamReadableWeb
  bodyPipeToNodeWritable: StreamPipeNode
  bodyPipeToWebWritable: StreamPipeWeb
}
function createHttpResponseObject(
  htmlRender: null | HtmlRender,
  { statusCode, renderFilePath }: { statusCode: 200 | 404 | 500; renderFilePath: null | string }
): HttpResponse | null {
  if (htmlRender === null) {
    return null
  }

  return {
    statusCode,
    get body() {
      if (typeof htmlRender !== 'string') {
        assert(renderFilePath)
        assertUsage(
          false,
          '`pageContext.httpResponse.body` is not available because your `render()` hook (' +
            renderFilePath +
            ') provides an HTML stream. Use `const body = await pageContext.httpResponse.getBody()` instead, see https://vite-plugin-ssr.com/html-streaming'
        )
      }
      const body = htmlRender
      return body
    },
    async getBody(): Promise<string> {
      const body = await getHtmlString(htmlRender)
      return body
    },
    get bodyNodeStream() {
      assert(htmlRender !== null)
      const nodeStream = getStreamReadableNode(htmlRender)
      assertUsage(
        nodeStream !== null,
        '`pageContext.httpResponse.bodyNodeStream` is not available: make sure your `render()` hook provides a Node.js Stream, see https://vite-plugin-ssr.com/html-streaming'
      )
      return nodeStream
    },
    get bodyWebStream() {
      assert(htmlRender !== null)
      const webStream = getStreamReadableWeb(htmlRender)
      assertUsage(
        webStream !== null,
        '`pageContext.httpResponse.bodyWebStream` is not available: make sure your `render()` hook provides a Web Stream, see https://vite-plugin-ssr.com/html-streaming'
      )
      return webStream
    },
    bodyPipeToWebWritable(writable: StreamWritableWeb) {
      const success = pipeToStreamWritableWeb(htmlRender, writable)
      assertUsage(
        success,
        '`pageContext.httpResponse.pipeToWebWritable` is not available: make sure your `render()` hook provides a Web Stream Pipe, see https://vite-plugin-ssr.com/html-streaming'
      )
    },
    bodyPipeToNodeWritable(writable: StreamWritableNode) {
      const success = pipeToStreamWritableNode(htmlRender, writable)
      assertUsage(
        success,
        '`pageContext.httpResponse.pipeToNodeWritable` is not available: make sure your `render()` hook provides a Node.js Stream Pipe, see https://vite-plugin-ssr.com/html-streaming'
      )
    }
  }
}

async function prerenderPage(
  pageContext: {
    url: string
    routeParams: Record<string, string>
    _isPreRendering: true
    _pageId: string
    _usesClientRouter: boolean
    _pageContextAlreadyProvidedByPrerenderHook?: true
  } & PageFiles &
    GlobalContext
) {
  assert(pageContext._isPreRendering === true)

  addComputedUrlProps(pageContext)

  const hookResult = await executeOnBeforeRenderHook(pageContext)
  if ('hookError' in hookResult) {
    throwPrerenderError(hookResult.hookError)
    assert(false)
  }

  const renderHookResult = await executeRenderHook(pageContext)
  if ('hookError' in renderHookResult) {
    throwPrerenderError(renderHookResult.hookError)
    assert(false)
  }
  assertUsage(
    renderHookResult.htmlRender !== null,
    "Pre-rendering requires your `render()` hook to provide HTML. Open a GitHub issue if that's a problem for you."
  )
  assert(!('_isPageContextRequest' in pageContext))
  const documentHtml = await getHtmlString(renderHookResult.htmlRender)
  assert(typeof documentHtml === 'string')
  if (!pageContext._usesClientRouter) {
    return { documentHtml, pageContextSerialized: null }
  } else {
    const pageContextSerialized = serializePageContextClientSide(pageContext, 'json')
    return { documentHtml, pageContextSerialized }
  }
}

async function renderStatic404Page(globalContext: GlobalContext & { _isPreRendering: true }) {
  const errorPageId = getErrorPageId(globalContext._allPageIds)
  if (!errorPageId) {
    return null
  }

  const pageContext = {
    ...globalContext,
    _pageId: errorPageId,
    is404: true,
    routeParams: {},
    url: '/fake-404-url', // A `url` is needed for `applyViteHtmlTransform`
    // `renderStatic404Page()` is about generating `dist/client/404.html` for static hosts; there is no Client Routing.
    _usesClientRouter: false
  }

  const pageFiles = await loadPageFiles(pageContext)
  objectAssign(pageContext, pageFiles)

  return prerenderPage(pageContext)
}

function getDefaultPassToClientProps(pageContext: { _pageId: string; pageProps?: Record<string, unknown> }): string[] {
  const passToClient = []
  if (isErrorPage(pageContext._pageId)) {
    assert(hasProp(pageContext, 'is404', 'boolean'))
    const pageProps = pageContext.pageProps || {}
    pageProps['is404'] = pageProps['is404'] || pageContext.is404
    pageContext.pageProps = pageProps
    passToClient.push(...['pageProps', 'is404'])
  }
  return passToClient
}

type PageContextPublic = {
  url: string
  urlNormalized: string
  urlPathname: string
  urlParsed: UrlParsed
  routeParams: Record<string, string>
  Page: unknown
  pageExports: Record<string, unknown>
}
function preparePageContextNode<T extends PageContextPublic>(pageContext: T) {
  assert(typeof pageContext.url === 'string')
  assert(typeof pageContext.urlNormalized === 'string')
  assert(typeof pageContext.urlPathname === 'string')
  assert(isPlainObject(pageContext.urlParsed))
  assert(isPlainObject(pageContext.routeParams))
  assert('Page' in pageContext)
  assert(isObject(pageContext.pageExports))
  sortPageContext(pageContext)
}

type PageServerFileProps = {
  filePath: string
  fileExports: {
    render?: Function
    prerender?: Function
    onBeforeRender?: Function
    doNotPrerender?: true
    setPageProps: never
    passToClient?: string[]
  }
}
type PageServerFile = null | PageServerFileProps
//*
type PageServerFiles =
  | { pageServerFile: PageServerFileProps; pageServerFileDefault: PageServerFileProps }
  | { pageServerFile: null; pageServerFileDefault: PageServerFileProps }
  | { pageServerFile: PageServerFileProps; pageServerFileDefault: null }
/*/
type PageServerFiles = {
  pageServerFile: PageServerFile | null
  pageServerFileDefault: PageServerFile | null
}
//*/

function assert_pageServerFile(pageServerFile: {
  filePath: string
  fileExports: Record<string, unknown>
}): asserts pageServerFile is PageServerFileProps {
  if (pageServerFile === null) return

  const { filePath, fileExports } = pageServerFile
  assert(filePath)
  assert(fileExports)

  const render = fileExports['render']
  assertUsage(!render || isCallable(render), `The \`render()\` hook defined in ${filePath} should be a function.`)

  assertUsage(
    !('onBeforeRender' in fileExports) || isCallable(fileExports['onBeforeRender']),
    `The \`onBeforeRender()\` hook defined in ${filePath} should be a function.`
  )

  assertUsage(
    !('passToClient' in fileExports) || hasProp(fileExports, 'passToClient', 'string[]'),
    `The \`passToClient_\` export defined in ${filePath} should be an array of strings.`
  )

  const prerender = fileExports['prerender']
  assertUsage(
    !prerender || isCallable(prerender),
    `The \`prerender()\` hook defined in ${filePath} should be a function.`
  )
}

async function loadPageFiles(pageContext: { _pageId: string; _allPageFiles: AllPageFiles; _isPreRendering: boolean }) {
  const { Page, pageExports, pageMainFile, pageMainFileDefault } = await loadPageMainFiles(pageContext)
  const pageClientPath = getPageClientPath(pageContext)

  const { pageServerFile, pageServerFileDefault } = await loadPageServerFiles(pageContext)

  const pageFiles = {
    Page,
    pageExports,
    _pageMainFile: pageMainFile,
    _pageMainFileDefault: pageMainFileDefault,
    _pageServerFile: pageServerFile,
    _pageServerFileDefault: pageServerFileDefault,
    _pageClientPath: pageClientPath
  }

  const passToClient: string[] = [
    ...getDefaultPassToClientProps(pageContext),
    ...(pageServerFile?.fileExports.passToClient || pageServerFileDefault?.fileExports.passToClient || [])
  ]
  objectAssign(pageFiles, {
    _passToClient: passToClient
  })

  const isPreRendering = pageContext._isPreRendering
  assert([true, false].includes(isPreRendering))
  const dependencies: string[] = [pageMainFile?.filePath, pageMainFileDefault?.filePath, pageClientPath].filter(
    (p): p is string => !!p
  )
  objectAssign(pageFiles, {
    _getPageAssets: async () => {
      const pageAssets = await getPageAssets(pageContext, dependencies, pageClientPath, isPreRendering)
      return pageAssets
    }
  })
  return pageFiles
}
function getPageClientPath(pageContext: { _pageId: string; _allPageFiles: AllPageFiles }): string {
  const { _pageId: pageId, _allPageFiles: allPageFiles } = pageContext
  const pageClientFiles = allPageFiles['.page.client']
  assertUsage(
    pageClientFiles.length > 0,
    'No `*.page.client.js` file found. Make sure to create one. You can create a `_default.page.client.js` which will apply as default to all your pages.'
  )
  const pageClientPath =
    findPageFile(pageClientFiles, pageId)?.filePath || findDefaultFile(pageClientFiles, pageId)?.filePath
  assert(pageClientPath)
  return pageClientPath
}
async function loadPageServerFiles(pageContext: {
  _pageId: string
  _allPageFiles: AllPageFiles
}): Promise<PageServerFiles> {
  const pageId = pageContext._pageId
  let serverFiles = pageContext._allPageFiles['.page.server']
  assertUsage(
    serverFiles.length > 0,
    'No `*.page.server.js` file found. Make sure to create one. You can create a `_default.page.server.js` which will apply as default to all your pages.'
  )

  const serverFile = findPageFile(serverFiles, pageId)
  const serverFileDefault = findDefaultFile(serverFiles, pageId)
  assert(serverFile || serverFileDefault)
  const pageServerFile = !serverFile
    ? null
    : {
        filePath: serverFile.filePath,
        fileExports: await serverFile.loadFile()
      }
  if (pageServerFile) {
    assertExportsOfServerPage(pageServerFile.fileExports, pageServerFile.filePath)
  }
  const pageServerFileDefault = !serverFileDefault
    ? null
    : {
        filePath: serverFileDefault.filePath,
        fileExports: await serverFileDefault.loadFile()
      }
  if (pageServerFileDefault) {
    assertExportsOfServerPage(pageServerFileDefault.fileExports, pageServerFileDefault.filePath)
  }
  if (pageServerFile !== null) {
    assert_pageServerFile(pageServerFile)
  }
  if (pageServerFileDefault !== null) {
    assert_pageServerFile(pageServerFileDefault)
  }
  if (pageServerFile !== null) {
    return { pageServerFile, pageServerFileDefault }
  }
  if (pageServerFileDefault !== null) {
    return { pageServerFile, pageServerFileDefault }
  }
  assert(false)
}

type OnBeforePrerenderHook = (globalContext: { _pageRoutes: PageRoutes }) => unknown
async function loadOnBeforePrerenderHook(globalContext: {
  _allPageFiles: AllPageFiles
}): Promise<null | { onBeforePrerenderHook: OnBeforePrerenderHook; hookFilePath: string }> {
  const defautFiles = findDefaultFiles(globalContext._allPageFiles['.page.server'])
  let onBeforePrerenderHook: OnBeforePrerenderHook | null = null
  let hookFilePath: string | undefined = undefined
  await Promise.all(
    defautFiles.map(async ({ filePath, loadFile }) => {
      const fileExports = await loadFile()
      assertExportsOfServerPage(fileExports, filePath)
      if ('onBeforePrerender' in fileExports) {
        assertUsage(
          hasProp(fileExports, 'onBeforePrerender', 'function'),
          `The \`export { onBeforePrerender }\` in ${filePath} should be a function.`
        )
        assertUsage(
          onBeforePrerenderHook === null,
          'There can be only one `onBeforePrerender()` hook. If you need to be able to define several, open a new GitHub issue.'
        )
        onBeforePrerenderHook = fileExports.onBeforePrerender
        hookFilePath = filePath
      }
    })
  )
  if (!onBeforePrerenderHook) {
    return null
  }
  assert(hookFilePath)
  return { onBeforePrerenderHook, hookFilePath }
}

function assertExportsOfServerPage(fileExports: Record<string, unknown>, filePath: string) {
  assertExports(
    fileExports,
    filePath,
    ['render', 'onBeforeRender', 'passToClient', 'prerender', 'doNotPrerender', 'onBeforePrerender'],
    {
      ['_onBeforePrerender']: 'onBeforePrerender'
    },
    {
      ['addPageContext']: 'onBeforeRender'
    }
  )
}

async function executeOnBeforeRenderHook(
  pageContext: {
    _pageId: string
    _pageServerFile: PageServerFile
    _pageServerFileDefault: PageServerFile
    _passToClient: string[]
    _pageContextAlreadyProvidedByPrerenderHook?: true
  } & PageContextPublic
): Promise<{ hookError: unknown; hookName: string; hookFilePath: string } | {}> {
  const onBeforeRender =
    pageContext._pageServerFile?.fileExports.onBeforeRender ||
    pageContext._pageServerFileDefault?.fileExports.onBeforeRender
  if (onBeforeRender && !pageContext._pageContextAlreadyProvidedByPrerenderHook) {
    const onBeforeRenderFilePath = pageContext._pageServerFile?.filePath || pageContext._pageServerFileDefault?.filePath
    assert(onBeforeRenderFilePath)
    preparePageContextNode(pageContext)

    Object.assign(pageContext, {
      _onBeforeRenderHookCalled: true
    })

    let hookReturn: unknown
    try {
      // We use a try-catch because the hook `onBeforeRender()` is user-defined and may throw an error.
      hookReturn = await onBeforeRender(pageContext)
    } catch (err) {
      return { hookError: err, hookName: 'onBeforeRender', hookFilePath: onBeforeRenderFilePath }
    }
    assertHookResult(hookReturn, 'onBeforeRender', ['pageContext'] as const, onBeforeRenderFilePath)
    Object.assign(pageContext, hookReturn?.pageContext)
  }

  return {}
}

type LoadedPageFiles = {
  _getPageAssets: () => Promise<PageAssets>
  _pageServerFile: PageServerFile
  _pageServerFileDefault: PageServerFile
  _pageMainFile: PageMainFile
  _pageMainFileDefault: PageMainFileDefault
  _pageClientPath: string
  _passToClient: string[]
}

async function executeRenderHook(
  pageContext: PageContextPublic & {
    _pageId: string
    _isPreRendering: boolean
  } & LoadedPageFiles
): Promise<
  | {
      renderFilePath: string
      htmlRender: null | HtmlRender
    }
  | {
      hookError: unknown
      hookName: string
      hookFilePath: string
    }
> {
  assert(pageContext._pageServerFile || pageContext._pageServerFileDefault)
  let render
  let renderFilePath
  const pageServerFile = pageContext._pageServerFile
  const pageRenderFunction = pageServerFile?.fileExports.render
  if (pageServerFile && pageRenderFunction) {
    render = pageRenderFunction
    renderFilePath = pageServerFile.filePath
  } else {
    const pageServerFileDefault = pageContext._pageServerFileDefault
    const pageDefaultRenderFunction = pageServerFileDefault?.fileExports.render
    if (pageServerFileDefault && pageDefaultRenderFunction) {
      render = pageDefaultRenderFunction
      renderFilePath = pageServerFileDefault.filePath
    }
  }
  assertUsage(
    render,
    'No `render()` hook found. Make sure to define a `*.page.server.js` file with `export function render() { /*...*/ }`. You can also `export { render }` in `_default.page.server.js` which will be the default `render()` hook of all your pages.'
  )
  assert(renderFilePath)

  preparePageContextNode(pageContext)

  let result: unknown
  try {
    // We use a try-catch because the `render()` hook is user-defined and may throw an error.
    result = await render(pageContext)
  } catch (hookError) {
    return { hookError, hookName: 'render', hookFilePath: renderFilePath }
  }
  if (isObject(result) && !isDocumentHtml(result)) {
    assertHookResult(result, 'render', ['documentHtml', 'pageContext'] as const, renderFilePath)
  }

  if (hasProp(result, 'pageContext')) {
    Object.assign(pageContext, result.pageContext)
  }

  const errPrefix = 'The `render()` hook exported by ' + renderFilePath
  const errSuffix = [
    "a string generated with the `escapeInject` template tag or a string returned by `dangerouslySkipEscape('<p>Some HTML</p>')`",
    ', see https://vite-plugin-ssr.com/escapeInject'
  ].join(' ')

  let documentHtml: unknown
  if (!isObject(result) || isDocumentHtml(result)) {
    assertUsage(
      typeof result !== 'string',
      [
        errPrefix,
        'returned a plain JavaScript string which is forbidden;',
        'instead, it should return',
        errSuffix
      ].join(' ')
    )
    assertUsage(
      result === null || isDocumentHtml(result),
      [
        errPrefix,
        'should return `null`, a string `documentHtml`, or an object `{ documentHtml, pageContext }`',
        'where `pageContext` is `undefined` or an object holding additional `pageContext` values',
        'and `documentHtml` is',
        errSuffix
      ].join(' ')
    )
    documentHtml = result
  } else {
    assertKeys(result, ['documentHtml', 'pageContext'] as const, errPrefix)
    if ('documentHtml' in result) {
      documentHtml = result.documentHtml
      assertUsage(
        typeof documentHtml !== 'string',
        [
          errPrefix,
          'returned `{ documentHtml }`, but `documentHtml` is a plain JavaScript string which is forbidden;',
          '`documentHtml` should be',
          errSuffix
        ].join(' ')
      )
      assertUsage(
        documentHtml === undefined || documentHtml === null || isDocumentHtml(documentHtml),
        [errPrefix, 'returned `{ documentHtml }`, but `documentHtml` should be', errSuffix].join(' ')
      )
    }
  }

  assert(documentHtml === undefined || documentHtml === null || isDocumentHtml(documentHtml))

  if (documentHtml === null || documentHtml === undefined) {
    return { htmlRender: null, renderFilePath }
  }

  const onErrorWhileStreaming = (err: unknown) => {
    objectAssign(pageContext, {
      _err: err,
      _serverSideErrorWhileStreaming: true
    })
    logError(err)
  }
  const htmlRender = await renderHtml(documentHtml, pageContext, renderFilePath, onErrorWhileStreaming)
  if (hasProp(htmlRender, 'hookError')) {
    return { hookError: htmlRender.hookError, hookName: 'render', hookFilePath: renderFilePath }
  }
  return { htmlRender, renderFilePath }
}

function assertHookResult<Keys extends readonly string[]>(
  hookResult: unknown,
  hookName: string,
  hookResultKeys: Keys,
  hookFile: string
): asserts hookResult is undefined | null | { [key in Keys[number]]?: unknown } {
  const errPrefix = `The \`${hookName}()\` hook exported by ${hookFile}`
  assertUsage(
    hookResult === null || hookResult === undefined || isPlainObject(hookResult),
    `${errPrefix} should return \`null\`, \`undefined\`, or a plain JavaScript object.`
  )
  if (hookResult === undefined || hookResult === null) {
    return
  }
  assertKeys(hookResult, hookResultKeys, errPrefix)
}

function assertKeys<Keys extends readonly string[]>(
  obj: Record<string, unknown>,
  keysExpected: Keys,
  errPrefix: string
): asserts obj is { [key in Keys[number]]?: unknown } {
  const keysUnknown: string[] = []
  const keys = Object.keys(obj)
  for (const key of keys) {
    if (!keysExpected.includes(key)) {
      keysUnknown.push(key)
    }
  }
  assertUsage(
    keysUnknown.length === 0,
    [
      errPrefix,
      'returned an object with unknown keys',
      stringifyStringArray(keysUnknown) + '.',
      'Only following keys are allowed:',
      stringifyStringArray(keysExpected) + '.'
    ].join(' ')
  )
}

function assertArguments(...args: unknown[]) {
  const pageContext = args[0]
  assertUsage(pageContext, '`renderPage(pageContext)`: argument `pageContext` is missing.')
  assertUsage(
    isPlainObject(pageContext),
    `\`renderPage(pageContext)\`: argument \`pageContext\` should be a plain JavaScript object, but you passed a \`pageContext\` with \`pageContext.constructor === ${
      (pageContext as any).constructor
    }\`.`
  )
  assertUsage(
    hasProp(pageContext, 'url'),
    '`renderPage(pageContext)`: The `pageContext` you passed is missing the property `pageContext.url`.'
  )
  assertUsage(
    typeof pageContext.url === 'string',
    '`renderPage(pageContext)`: `pageContext.url` should be a string but `typeof pageContext.url === "' +
      typeof pageContext.url +
      '"`.'
  )
  assertUsage(
    pageContext.url.startsWith('/') || pageContext.url.startsWith('http'),
    '`renderPage(pageContext)`: `pageContext.url` should start with `/` (e.g. `/product/42`) or `http` (e.g. `http://example.org/product/42`) but `pageContext.url === "' +
      pageContext.url +
      '"`.'
  )
  try {
    const { url } = pageContext
    const urlWithOrigin = url.startsWith('http') ? url : 'http://fake-origin.example.org' + url
    // `new URL()` conveniently throws if URL is not an URL
    new URL(urlWithOrigin)
  } catch (err) {
    assertUsage(
      false,
      '`renderPage(pageContext)`: `pageContext.url` should be a URL but `pageContext.url==="' + pageContext.url + '"`.'
    )
  }
  const len = args.length
  assertUsage(
    len === 1,
    `\`renderPage(pageContext)\`: You passed ${len} arguments but \`renderPage()\` accepts only one argument.'`
  )
}

function warnMissingErrorPage() {
  const { isProduction } = getSsrEnv()
  if (!isProduction) {
    assertWarning(
      false,
      'No `_error.page.js` found. We recommend creating a `_error.page.js` file. (This warning is not shown in production.)'
    )
  }
}
function warnCouldNotRender500Page({ hookFilePath, hookName }: { hookFilePath: string; hookName: string }) {
  assert(!hookName.endsWith('()'))
  assertWarning(
    false,
    `The error page \`_error.page.js\` could be not rendered because your \`${hookName}()\` hook exported by ${hookFilePath} threw an error.`
  )
}
function warn404(pageContext: { urlPathname: string; _pageRoutes: PageRoutes }) {
  const { isProduction } = getSsrEnv()
  const pageRoutes = pageContext._pageRoutes
  assertUsage(
    pageRoutes.length > 0,
    'No page found. Create a file that ends with the suffix `.page.js` (or `.page.vue`, `.page.jsx`, ...).'
  )
  const { urlPathname } = pageContext
  if (!isProduction && !isFileRequest(urlPathname)) {
    assertWarning(
      false,
      [
        `URL \`${urlPathname}\` is not matching any of your ${pageRoutes.length} page routes (this warning is not shown in production):`,
        ...getPagesAndRoutesInfo(pageRoutes)
      ].join('\n')
    )
  }
}
function getPagesAndRoutesInfo(pageRoutes: PageRoutes) {
  return pageRoutes
    .map((pageRoute) => {
      const { pageId, filesystemRoute, pageRouteFile } = pageRoute
      let route
      let routeType
      if (pageRouteFile) {
        const { routeValue } = pageRouteFile
        route =
          typeof routeValue === 'string'
            ? routeValue
            : truncateString(String(routeValue).split(/\s/).filter(Boolean).join(' '), 64)
        routeType = typeof routeValue === 'string' ? 'Route String' : 'Route Function'
      } else {
        route = filesystemRoute
        routeType = 'Filesystem Route'
      }
      return `\`${route}\` (${routeType} of \`${pageId}.page.*\`)`
    })
    .sort(compareString)
    .map((line, i) => {
      const nth = (i + 1).toString().padStart(pageRoutes.length.toString().length, '0')
      return ` (${nth}) ${line}`
    })
}

function truncateString(str: string, len: number) {
  if (len > str.length) {
    return str
  } else {
    str = str.substring(0, len)
    return str + '...'
  }
}

function isFileRequest(urlPathname: string) {
  assert(urlPathname.startsWith('/'))
  const paths = urlPathname.split('/')
  const lastPath = paths[paths.length - 1]
  assert(typeof lastPath === 'string')
  const parts = lastPath.split('.')
  if (parts.length < 2) {
    return false
  }
  const fileExtension = parts[parts.length - 1]
  assert(typeof fileExtension === 'string')
  return /^[a-z0-9]+$/.test(fileExtension)
}

function getUrlNormalized(url: string) {
  const { urlNormalized } = analyzeUrl(url)
  return urlNormalized
}

function analyzeUrl(url: string): {
  urlNormalized: string
  isPageContextRequest: boolean
  hasBaseUrl: boolean
} {
  assert(url.startsWith('/') || url.startsWith('http'))

  const { urlWithoutPageContextRequestSuffix, isPageContextRequest } = handlePageContextRequestSuffix(url)
  url = urlWithoutPageContextRequestSuffix

  const { urlWithoutBaseUrl, hasBaseUrl } = analyzeBaseUrl(url)
  url = urlWithoutBaseUrl

  url = handleUrlOrigin(url).urlWithoutOrigin
  assert(url.startsWith('/'))

  const urlNormalized = url
  assert(urlNormalized.startsWith('/'))
  return { urlNormalized, isPageContextRequest, hasBaseUrl }
}

async function getGlobalContext() {
  const globalContext = {
    _getUrlNormalized: (url: string) => getUrlNormalized(url)
  }

  const allPageFiles = await getAllPageFiles()
  objectAssign(globalContext, {
    _allPageFiles: allPageFiles
  })

  const allPageIds = await getAllPageIds(allPageFiles)
  objectAssign(globalContext, { _allPageIds: allPageIds })

  const { pageRoutes, onBeforeRouteHook } = await loadPageRoutes(globalContext)
  objectAssign(globalContext, { _pageRoutes: pageRoutes, _onBeforeRouteHook: onBeforeRouteHook })

  return globalContext
}

function throwPrerenderError(err: unknown) {
  viteErrorCleanup(err)

  if (hasProp(err, 'stack')) {
    throw err
  } else {
    throw new Error(err as any)
  }
}
function logError(err: unknown) {
  assertUsage(
    isObject(err),
    'Your source code threw a primitive value as error (this should never happen). Contact the `vite-plugin-ssr` maintainer to get help.'
  )
  {
    const key = '_wasAlreadyConsoleLogged'
    if (err[key]) {
      return
    }
    err[key] = true
  }

  viteErrorCleanup(err)

  // We ensure we print a string; Cloudflare Workers doesn't seem to properly stringify `Error` objects.
  const errStr = (hasProp(err, 'stack') && String(err.stack)) || String(err)
  console.error(errStr)
}

function viteErrorCleanup(err: unknown) {
  const { viteDevServer } = getSsrEnv()
  if (viteDevServer) {
    if (hasProp(err, 'stack')) {
      viteDevServer.ssrFixStacktrace(err as Error)
    }
  }
}
