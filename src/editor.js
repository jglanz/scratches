const fs = require('fs')
const path = require('path')
const { remote, ipcRenderer: ipc } = require('electron')

const CodeMirror = require('codemirror')
const ts = require('typescript')

require('codemirror/mode/javascript/javascript')
require('codemirror/addon/edit/matchbrackets')
require('codemirror/keymap/vim')

const opts = {
  tabSize: 2,
  lineNumbers: JSON.parse(window.localStorage.lineNumbers || false),
  styleActiveLine: false,
  matchBrackets: true,
  theme: window.localStorage.theme || 'light',
  autoeval: JSON.parse(window.localStorage.autoeval || true)
}

document.body.setAttribute('data-theme', opts.theme.toLowerCase())

const editor = CodeMirror.fromTextArea(
  document.getElementById('editor'),
  Object.assign({}, opts, {
    autofocus: true,
    mode: 'javascript',
    gutters: ['CodeMirror-lint-markers'],
    lint: true
  })
)

const output = CodeMirror.fromTextArea(
  document.getElementById('output'),
  Object.assign({}, opts, { readOnly: true })
)

async function clearDocumentWindow () {
  await sandbox.webContents.executeJavaScript(`
    try {
      eval(\`(function() { document.body.innerHTML='' })()\`)
      null
    } catch (ex) {
      ex.stack
    }
  `)
}

const clearEditorPanes = () => {
  editor.setValue('')
  output.setValue('')
  window.localStorage.input = ''
  clearDocumentWindow()
  sandbox.reload()
}

setTimeout(() => {
  editor.refresh()
  output.refresh()
}, 128)

const sandbox = new remote.BrowserWindow({
  show: !!window.localStorage.sandbox,
  width: 450,
  height: 400,
  minWidth: 150,
  minHeight: 200,
  title: 'Document Window',
  alwaysOnTop: JSON.parse(window.localStorage.sandboxOnTop || 'false')
})

sandbox.loadURL(`file://${__dirname}/../../../static/blank.html`)

sandbox.webContents.on('did-finish-load', () => {
  const str = window.localStorage.input || ''
  if (window.localStorage.vimMode) {
    editor.setOption('keyMap', 'vim')
  }
  editor.setValue(str)
  render(str)
})

if (!window.localStorage.sandbox) {
  sandbox.hide()
}

if (window.localStorage.autoeval === 'undefined') {
  window.localStorage.autoeval = true
}

if (window.localStorage.hideOutput) {
  document.body.classList.add('hide-output')
}

function parseChunk (chunk) {
  const line = parseInt(chunk.split(' ')[0], 10)
  const content = chunk.replace(/^\d+ /, '')
  return { line, content }
}

async function render (s) {
  output.setValue('')
  window.localStorage.input = s

  s = s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\${/g, '\\${')

  const lines = s.split('\n').map((line, lineno) => {
    return line.replace(/console.log\(([^)]+)\)/, `console.log(${String(lineno)},$1)`)
  })

  // if the last line is a comment, throw it away.
  const lastLine = lines[lines.length - 1]
  if (/^\/\/|\/\*/.test(lastLine)) {
    lines.pop()
  }

  s = lines.join('\n')
  if (window.localStorage.typescript) {
    s = ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  }
  let result = await sandbox.webContents.executeJavaScript(`
    try {
      eval(\`(function() { ${s}; })()\`)
      null
    } catch (ex) {
      ex.stack
    }
  `)

  if (typeof result === 'string') {
    if (/SyntaxError: Unexpected token ;/.test(result)) return

    const lines = result.split('\n').slice(0, -4)
    const message = lines.shift()
    const stack = lines.map(line => {
      const info = line.split(' ')
      return `  at ${info[info.length - 1].slice(0, -1)}`
    }).join('\n')

    return output.setValue([message, stack].join('\n'))
  }
}

let renderTimeout = null

function evaluateSource () {
  const str = editor.getValue()
  clearTimeout(renderTimeout)
  renderTimeout = setTimeout(() => render(str), 512)
}

window.events.on('editor:eval', evaluateSource)

editor.on('change', event => {
  if (!opts.autoeval) return
  evaluateSource()
})

//
// Window events
//
ipc.on('log', (event, value) => {
  let { line, content } = parseChunk(value)
  content = content.replace(/\\n/g, '\n')

  window.requestAnimationFrame(() => {
    if (window.localStorage.matchingLines) {
      if (line >= output.lineCount()) {
        const paddingTotal = line - output.lineCount()
        const padding = Array(paddingTotal + 1).fill('\n').join('')
        const next = output.getValue() + padding
        output.setValue(next)
      }

      output.replaceRange(content, { line: line })
    } else {
      output.replaceRange(content + '\n', { line: Infinity })
    }
  })
})

window.events.on('cwd', p => {
  remote.dialog.showOpenDialog({ properties: ['openDirectory'] }, (p) => {
    if (!p[0]) return

    const cwd = /node_modules\/?$/.test(p[0])
      ? p[0]
      : path.join(p[0], 'node_modules')

    sandbox.webContents.send('cwd', cwd)
    render(editor.getValue())
  })
})

window.events.on('matchinglines', () => {
  if (window.localStorage.matchingLines) {
    delete window.localStorage.matchingLines
  } else {
    window.localStorage.matchingLines = true
  }
  render(editor.getValue())
})

window.events.on('output:toggle', () => {
  if (window.localStorage.hideOutput) {
    document.body.classList.remove('hide-output')
    delete window.localStorage.hideOutput
  } else {
    document.body.classList.add('hide-output')
    window.localStorage.hideOutput = true
  }
})

window.events.on('sandbox:ontop', () => {
  if (window.localStorage.sandboxOnTop) {
    sandbox.setAlwaysOnTop(false)
    delete window.localStorage.sandboxOnTop
  } else {
    window.localStorage.sandboxOnTop = true
    sandbox.setAlwaysOnTop(true)
  }
})

window.events.on('sandbox:toggle', () => {
  if (window.localStorage.sandbox) {
    sandbox.hide()
    delete window.localStorage.sandbox
  } else {
    sandbox.show()
    window.localStorage.sandbox = true
  }
})

window.events.on('editor:autoeval', () => {
  if (opts.autoeval) {
    opts.autoeval = false
  } else {
    opts.autoeval = true
  }

  window.localStorage.autoeval = opts.autoeval
})

window.events.on('editor:theme', name => {
  name = name.toLowerCase()
  document.body.setAttribute('data-theme', name)
  editor.setOption('theme', name)
  output.setOption('theme', name)
})

window.events.on('editor:linenumbers', () => {
  const state = opts.lineNumbers = !opts.lineNumbers
  window.localStorage.lineNumbers = state
  editor.setOption('lineNumbers', state)
  output.setOption('lineNumbers', state)
})

window.events.on('vimMode:toggle', () => {
  if (window.localStorage.vimMode) {
    delete window.localStorage.vimMode
    editor.setOption('keyMap', 'default')
  } else {
    window.localStorage.vimMode = true
    editor.setOption('keyMap', 'vim')
  }
})

window.events.on('file:load', () => {
  remote.dialog.showOpenDialog({ properties: ['openFile'] }, filenames => {
    if (filenames === undefined) return

    const filename = filenames[0]
    window.sessionStorage.saveFilename = filename

    fs.readFile(filename, 'utf-8', (err, data) => {
      if (err) {
        remote.dialog.showErrorBox('Load Error', 'There was an error loading.')
      } else {
        editor.setValue(data)
      }
    })
  })
})

const saveCurrentFile = filename => {
  const content = editor.getValue()
  fs.writeFile(filename, content, err => {
    if (err) {
      remote.dialog.showErrorBox('Save Error', 'There was an error saving.')
    }
  })
}

const saveForFirstTime = () => {
  remote.dialog.showSaveDialog(filename => {
    if (filename === undefined) return

    window.sessionStorage.saveFilename = filename
    saveCurrentFile(filename)
  })
}

window.events.on('file:save', () => {
  const saveFilename = window.sessionStorage.saveFilename

  if (saveFilename === undefined) {
    saveForFirstTime()
  } else {
    saveCurrentFile(saveFilename)
  }
})

window.events.on('file:saveAs', () => {
  saveForFirstTime()
})

window.events.on('editor:typescript', () => {
  if (window.localStorage.typescript) {
    delete window.localStorage.typescript
  } else {
    window.localStorage.typescript = true
  }
  render(editor.getValue())
})

window.events.on('editor:clear', () => {
  clearEditorPanes()
})
