

/**
 * Note: We can't initialize modeHandler here, or even inside activate(), because some people
 * see a bug where VSC hasn't fully initialized yet, which pretty much breaks VSCodeVim entirely.
 */
let modeHandlerToEditorIdentity: { [key: string]: ModeHandler } = {};
let previousActiveEditorId: EditorIdentity = new EditorIdentity();

export async function getAndUpdateModeHandler(): Promise<ModeHandler> {
  const prevHandler = modeHandlerToEditorIdentity[previousActiveEditorId.toString()];
  const activeEditorId = new EditorIdentity(vscode.window.activeTextEditor);

  let curHandler = modeHandlerToEditorIdentity[activeEditorId.toString()];
  if (!curHandler) {
    const newModeHandler = await new ModeHandler();
    if (Configuration.enableNeovim) {
      await Neovim.initNvim(newModeHandler.vimState);
    }
    modeHandlerToEditorIdentity[activeEditorId.toString()] = newModeHandler;
    extensionContext.subscriptions.push(newModeHandler);

    curHandler = newModeHandler;
  }

  curHandler.vimState.editor = vscode.window.activeTextEditor!;
  if (!prevHandler || curHandler.identity !== prevHandler.identity) {
    setTimeout(() => {
      curHandler.syncCursors();
    }, 0);
  }

  if (previousActiveEditorId.hasSameBuffer(activeEditorId)) {
    if (!previousActiveEditorId.isEqual(activeEditorId)) {
      // We have opened two editors, working on the same file.
      previousActiveEditorId = activeEditorId;
    }
  } else {
    previousActiveEditorId = activeEditorId;

    await curHandler.updateView(curHandler.vimState, { drawSelection: false, revealRange: false });
  }

  if (prevHandler && curHandler.vimState.focusChanged) {
    curHandler.vimState.focusChanged = false;
    prevHandler.vimState.focusChanged = true;
  }

  vscode.commands.executeCommand('setContext', 'vim.mode', curHandler.vimState.currentModeName());

  // Temporary workaround for vscode bug not changing cursor style properly
  // https://github.com/Microsoft/vscode/issues/17472
  // https://github.com/Microsoft/vscode/issues/17513
  const options = curHandler.vimState.editor.options;
  const desiredStyle = options.cursorStyle;

  // Temporarily change to any other cursor style besides the desired type, then change back
  if (desiredStyle === vscode.TextEditorCursorStyle.Block) {
    curHandler.vimState.editor.options.cursorStyle = vscode.TextEditorCursorStyle.Line;
    curHandler.vimState.editor.options.cursorStyle = desiredStyle;
  } else {
    curHandler.vimState.editor.options.cursorStyle = vscode.TextEditorCursorStyle.Block;
    curHandler.vimState.editor.options.cursorStyle = desiredStyle;
  }

  return curHandler;
}

class CompositionState {
  public isInComposition: boolean = false;
  public composingText: string = '';
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  let compositionState = new CompositionState();

  // Event to update active configuration items when changed without restarting vscode
  vscode.workspace.onDidChangeConfiguration((e: void) => {
    Configuration.updateConfiguration();

    /* tslint:disable:forin */
    // Update the remappers foreach modehandler
    for (let mh in modeHandlerToEditorIdentity) {
      modeHandlerToEditorIdentity[mh].createRemappers();
    }
  });

  vscode.window.onDidChangeActiveTextEditor(handleActiveEditorChange, this);

  vscode.workspace.onDidChangeTextDocument(event => {
    if (Configuration.disableExt) {
      return;
    }

    /**
     * Change from vscode editor should set document.isDirty to true but they initially don't!
     * There is a timing issue in vscode codebase between when the isDirty flag is set and
     * when registered callbacks are fired. https://github.com/Microsoft/vscode/issues/11339
     */

    let contentChangeHandler = (modeHandler: ModeHandler) => {
      if (modeHandler.vimState.currentMode === ModeName.Insert) {
        if (modeHandler.vimState.historyTracker.currentContentChanges === undefined) {
          modeHandler.vimState.historyTracker.currentContentChanges = [];
        }

        modeHandler.vimState.historyTracker.currentContentChanges = modeHandler.vimState.historyTracker.currentContentChanges.concat(
          event.contentChanges
        );
      }
    };

    if (Globals.isTesting) {
      contentChangeHandler(Globals.modeHandlerForTesting as ModeHandler);
    } else {
      _.filter(
        modeHandlerToEditorIdentity,
        modeHandler => modeHandler.identity.fileName === event.document.fileName
      ).forEach(modeHandler => {
        contentChangeHandler(modeHandler);
      });
    }
    setTimeout(() => {
      if (!event.document.isDirty && !event.document.isUntitled && event.contentChanges.length) {
        handleContentChangedFromDisk(event.document);
      }
    }, 0);
  });

  overrideCommand(context, 'type', async args => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();

      if (compositionState.isInComposition) {
        compositionState.composingText += args.text;
      } else {
        await mh.handleKeyEvent(args.text);
      } 
    });
  });

  overrideCommand(context, 'replacePreviousChar', async args => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();

      if (compositionState.isInComposition) {
        compositionState.composingText =
          compositionState.composingText.substr(
            0,
            compositionState.composingText.length - args.replaceCharCnt
          ) + args.text;
      } else {
        await vscode.commands.executeCommand('default:replacePreviousChar', {
          text: args.text,
          replaceCharCnt: args.replaceCharCnt,
        });
        mh.vimState.cursorPosition = Position.FromVSCodePosition(
          mh.vimState.editor.selection.start
        );
        mh.vimState.cursorStartPosition = Position.FromVSCodePosition(
          mh.vimState.editor.selection.start
        );
      }
    });
  });

  overrideCommand(context, 'compositionStart', async args => {
    taskQueue.enqueueTask(async () => {
      compositionState.isInComposition = true;
    });
  });

  overrideCommand(context, 'compositionEnd', async args => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      let text = compositionState.composingText;
      compositionState = new CompositionState();
      await mh.handleMultipleKeyEvents(text.split(''));
    });
  });

  registerCommand(context, 'extension.showCmdLine', () => {
    showCmdLine(
      '',
      modeHandlerToEditorIdentity[new EditorIdentity(vscode.window.activeTextEditor).toString()]
    );
  });

  registerCommand(context, 'vim.remap', async (args: ICodeKeybinding) => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (args.after) {
        for (const key of args.after) {
          await mh.handleKeyEvent(AngleBracketNotation.Normalize(key));
        }
        return;
      }

      if (args.commands) {
        for (const command of args.commands) {
          // Check if this is a vim command by looking for :
          if (command.command.slice(0, 1) === ':') {
            await runCmdLine(command.command.slice(1, command.command.length), mh);
            await mh.updateView(mh.vimState);
          } else {
            await vscode.commands.executeCommand(command.command, command.args);
          }
        }
      }
    });
  });

  vscode.workspace.onDidCloseTextDocument(event => {
    const documents = vscode.workspace.textDocuments;

    // Delete modehandler if vscode knows NOTHING about this document. This does
    // not handle the case of the same file open twice. This only handles the
    // case of deleting a modehandler once all tabs of this document have been
    // closed
    for (let mh in modeHandlerToEditorIdentity) {
      const editor = modeHandlerToEditorIdentity[mh].vimState.editor.document;
      if (documents.indexOf(editor) === -1) {
        delete modeHandlerToEditorIdentity[mh];
      }
    }
  });

  /**
   * Toggles the VSCodeVim extension between Enabled mode and Disabled mode. This
   * function is activated by calling the 'toggleVim' command from the Command Palette.
   *
   * @param isDisabled if true, sets VSCodeVim to Disabled mode; else sets to enabled mode
   */
  async function toggleExtension(isDisabled: boolean) {
    await vscode.commands.executeCommand('setContext', 'vim.active', !isDisabled);
    if (isDisabled) {
      vscode.window.visibleTextEditors.forEach(editor => {
        let options = editor.options;
        switch (Configuration.userCursorString) {
          case 'line':
            options.cursorStyle = vscode.TextEditorCursorStyle.Line;
            break;
          case 'block':
            options.cursorStyle = vscode.TextEditorCursorStyle.Block;
            break;
          case 'underline':
            options.cursorStyle = vscode.TextEditorCursorStyle.Underline;
            break;
          default:
            break;
        }
        editor.options = options;
      });
      let mh = await getAndUpdateModeHandler();
      mh.setStatusBarText('-- VIM: DISABLED --');
    } else {
      compositionState = new CompositionState();
      modeHandlerToEditorIdentity = {};
      let mh = await getAndUpdateModeHandler();
      mh.updateView(mh.vimState, { drawSelection: false, revealRange: false });
    }
  }

  registerCommand(context, 'toggleVim', async () => {
    Configuration.disableExt = !Configuration.disableExt;
    toggleExtension(Configuration.disableExt);
  });

  // Clear boundKeyCombinations array incase there are any entries in it so
  // that we have a clean list of keys with no duplicates
  Configuration.boundKeyCombinations = [];

  for (let keybinding of packagejson.contributes.keybindings) {
    if (keybinding.when.indexOf('listFocus') !== -1) {
      continue;
    }
    let keyToBeBound = '';
    /**
     * On OSX, handle mac keybindings if we specified one.
     */
    if (process.platform === 'darwin') {
      keyToBeBound = keybinding.mac || keybinding.key;
    } else if (process.platform === 'linux') {
      keyToBeBound = keybinding.linux || keybinding.key;
    } else {
      keyToBeBound = keybinding.key;
    }

    const bracketedKey = AngleBracketNotation.Normalize(keyToBeBound);

    // Store registered key bindings in bracket notation form
    Configuration.boundKeyCombinations.push(bracketedKey);

    registerCommand(context, keybinding.command, () => handleKeyEvent(`${bracketedKey}`));
  }

  // Update configuration now that bound keys array is populated
  Configuration.updateConfiguration();

  // Initialize mode handler for current active Text Editor at startup.
  if (vscode.window.activeTextEditor) {
    let mh = await getAndUpdateModeHandler();
    mh.updateView(mh.vimState, { drawSelection: false, revealRange: false });
  }

  // This is called last because getAndUpdateModeHandler() will change cursor
  toggleExtension(Configuration.disableExt);
}

function overrideCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any
) {
  let disposable = vscode.commands.registerCommand(command, async args => {
    if (Configuration.disableExt) {
      await vscode.commands.executeCommand('default:' + command, args);
      return;
    }

    if (!vscode.window.activeTextEditor) {
      return;
    }

    if (
      vscode.window.activeTextEditor.document &&
      vscode.window.activeTextEditor.document.uri.toString() === 'debug:input'
    ) {
      await vscode.commands.executeCommand('default:' + command, args);
      return;
    }

    callback(args);
  });
  context.subscriptions.push(disposable);
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any
) {
  let disposable = vscode.commands.registerCommand(command, async args => {
    if (!vscode.window.activeTextEditor) {
      return;
    }

    callback(args);
  });
  context.subscriptions.push(disposable);
}

async function handleKeyEvent(key: string): Promise<void> {
  const mh = await getAndUpdateModeHandler();

  taskQueue.enqueueTask(async () => {
    await mh.handleKeyEvent(key);
  });
}

function handleContentChangedFromDisk(document: vscode.TextDocument): void {
  _.filter(
    modeHandlerToEditorIdentity,
    modeHandler => modeHandler.identity.fileName === document.fileName
  ).forEach(modeHandler => {
    modeHandler.vimState.historyTracker.clear();
  });
}

async function handleActiveEditorChange(): Promise<void> {
  if (Configuration.disableExt) {
    return;
  }

  // Don't run this event handler during testing
  if (Globals.isTesting) {
    return;
  }

  taskQueue.enqueueTask(async () => {
    if (vscode.window.activeTextEditor !== undefined) {
      const mh = await getAndUpdateModeHandler();

      mh.updateView(mh.vimState, { drawSelection: false, revealRange: false });
    }
  });
}

process.on('unhandledRejection', function(reason: any, p: any) {
  console.log('Unhandled Rejection at: Promise ', p, ' reason: ', reason);
});
