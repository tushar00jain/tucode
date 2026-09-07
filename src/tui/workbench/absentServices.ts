/*---------------------------------------------------------------------------------------------
 *  The services the vendored views take and this frontend does not have.
 *
 *  `ExplorerService` takes five services by constructor and reaches four of them from one
 *  method each — the clipboard from `setToCopy`, the bulk-edit and progress services from
 *  `applyBulkEdit`, and the host service for one focus event. None of the four can stand up here:
 *  they are browser implementations over a layout service.
 *
 *  So each is a proxy that answers the members its readers actually reach and **throws on every
 *  other**. What it answers is the truth rather than a plausible stand-in: the window's focus never
 *  changes, and there is no gallery to request an extension resource from. What it throws on is an
 *  operation this frontend cannot perform yet, and it says so where it is asked rather than
 *  silently doing nothing.
 *
 *  `absent` is exported for services which are only partly available. Editor groups and
 *  `IEditorService` are not proxies: both frontends now register their upstream implementations.
 *
 *  They go into the service collection, because `files.contribution.ts` registers
 *  `IExplorerService` as a singleton and upstream's own container is what builds it. A future
 *  consumer therefore gets these too — which is the reason they throw rather than no-op: an
 *  unanswerable call fails at the line that made it instead of turning into a wrong answer three
 *  layers up.
 *
 *  The search pane adds two more, for the same reason: `QueryBuilder` takes
 *  `IEditorGroupsService` and `SearchModelImpl` takes `INotebookSearchService`. The second answers
 *  rather than throws, because `SearchModelImpl` merges its result into every search.
 *
 *  Two more exist because `FilesRenderer`'s seven services are **not** all registered, contrary to
 *  what a reading of the registrations suggests: `IContextViewService` is registered nowhere this boot reaches,
 *  and `ResourceLabels` takes `ITextFileService`. (`IContextMenuService` was a third until A2, which
 *  registered a real one — `tui/workbench/contextMenu.ts`.)
 *
 *  **`ITextFileService`, `IBulkEditService` and `IReplaceService` left this file in `§12.3`**, which
 *  registered upstream's own three so that a search result could be replaced. What replaced them is
 *  three more entries of exactly this shape, each named at its own definition below — a code editor,
 *  a save target and a notebook, none of which a terminal frontend has — plus an answer on each of
 *  `IProgressService` and `ILifecycleService`, because the save path runs *inside* the first and
 *  holds a veto against the second.
 *
 *  Upstream counterpart: none — each entry stands in for a service tscode *implements*, one file each, and naming one would claim a port that is deliberately not here.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../vs/base/common/event.js';
import { Disposable } from '../../vs/base/common/lifecycle.js';
import type { URI } from '../../vs/base/common/uri.js';
import { ICodeEditorService } from '../../vs/editor/browser/services/codeEditorService.js';
import { IClipboardService } from '../../vs/platform/clipboard/common/clipboardService.js';
import { IContextViewService } from '../../vs/platform/contextview/browser/contextView.js';
import { IHoverService } from '../../vs/platform/hover/browser/hover.js';
import { IProgress, IProgressService, IProgressStep, Progress } from '../../vs/platform/progress/common/progress.js';
import { IRequestService } from '../../vs/platform/request/common/request.js';
import { IActivityService } from '../../vs/workbench/services/activity/common/activity.js';
import { IHostService } from '../../vs/workbench/services/host/browser/host.js';
import { ITitleService } from '../../vs/workbench/services/title/browser/titleService.js';
import { ILifecycleService } from '../../vs/workbench/services/lifecycle/common/lifecycle.js';

import { absent } from '../../workbench/absentServices.js';
export { absent, NO_NOTEBOOK_MODELS, NO_NOTEBOOKS, NO_NOTEBOOK_SEARCH } from '../../workbench/absentServices.js';

/**
 * A terminal program's window focus is the terminal's business, not ours: it never changes, and
 * the program is running, so it has it. `hasFocus` is read for one thing — the keybinding service
 * leaves chord mode when focus is lost, which here cannot happen.
 */
export const NO_HOST: IHostService = absent<IHostService>('IHostService', {
	onDidChangeFocus: Event.None,
	hasFocus: true,
	focus: async () => { },
	moveTop: async () => { }
});

let resourceClipboard: readonly URI[] = [];

/**
 * Explorer cut/copy/paste transfers resource identities inside this process. It deliberately does
 * not read or write a platform pasteboard: text and external-file clipboard operations remain
 * unavailable, while upstream's ExplorerService keeps owning the transfer semantics.
 */
export const RESOURCE_CLIPBOARD: IClipboardService = absent<IClipboardService>('IClipboardService', {
	writeResources: async resources => { resourceClipboard = Object.freeze([...resources]); },
	readResources: async () => [...resourceClipboard],
	hasResources: async () => resourceClipboard.length > 0,
	clearInternalState: () => { resourceClipboard = []; }
}, 'only process-local Explorer resource transfer is available');

/**
 * A terminal frontend draws no progress: upstream's `ProgressService` puts it in a notification, a
 * dialog, the status bar's spinner or a view's own indicator, and none of those four exists here.
 * What must not go missing with the indicator is the *work* — `TextFileEditorModel.save` runs its
 * whole save inside `withProgress` — so the task runs, against upstream's own do-nothing `IProgress`.
 */
export const NO_PROGRESS: IProgressService = absent<IProgressService>('IProgressService', {
	withProgress: <R>(_options: unknown, task: (progress: IProgress<IProgressStep>) => Promise<R>) => task(Progress.None)
}, 'a terminal frontend has nowhere to draw progress');

/**
 * `AbstractTextFileService.saveAs` copies a model's *transient* properties — a code editor's own
 * per-model scratch state — onto the target, which is the one place this is reached from. There is
 * no Save As here, and no code editor for one to have properties on.
 */
export const NO_CODE_EDITORS: ICodeEditorService = absent<ICodeEditorService>('ICodeEditorService', {},
	'this frontend has no Monaco code editor to hold one');

/**
 * `LabelService` takes `ILifecycleService` and never reads it — the parameter outlived whatever
 * used it upstream — and it is the first service in this boot to ask for one. There is no non-DOM
 * implementation in the tree (`BrowserLifecycleService` binds `beforeunload` and `pagehide`), so
 * this names itself on the first real reader.
 *
 * `onBeforeShutdown` is answered because `BrowserTextFileService` and `BulkEditService` both hold a
 * veto against it, and a veto phase is exactly what this frontend has none of: the process ends
 * when the pty does. Nothing here holds unsaved work for one to protect — a replace saves as it
 * goes.
 */
export const NO_LIFECYCLE: ILifecycleService = absent<ILifecycleService>('ILifecycleService', {
	onBeforeShutdown: Event.None,
	onWillShutdown: Event.None
} as unknown as Partial<ILifecycleService>, 'nothing drives a lifecycle phase in a terminal frontend');

/**
 * `ExtensionResourceLoaderService` reaches this for one branch — a resource whose URI is a
 * *gallery* resource, fetched over HTTP. `product.json` has no `extensionsGallery`, so
 * `isExtensionGalleryResource` is false for every URI this fork ever asks about and the read goes
 * through `IFileService`, which is what loads the theme JSON and every grammar. T01 deleted both
 * of upstream's implementations with the rest of the browser tree; there is nothing to register.
 */
export const NO_REQUESTS: IRequestService = absent<IRequestService>('IRequestService', {},
	'this fork has no extension gallery to request anything from');

/**
 * Notebook search is a search over cells of an open or serialized notebook, and this fork has no
 * notebook: `NotebookSearchService` takes `INotebookService`, `INotebookEditorService` and the
 * editor part. `SearchModelImpl` merges this answer with the text search's, so the empty triple is
 * the same shape upstream produces for a workspace with no notebooks in it.
 */
/**
 * The two the row renderers take for their *editing* arm: `FilesRenderer` reaches the context view
 * from `renderInputBox` and the context menu from the rename it opens, and both are the input box
 * this pane has none of (`setEditable` is a no-op). Upstream registers neither below the workbench
 * layout — `ContextViewService` is built on `ILayoutService`'s container.
 */
export const NO_CONTEXT_VIEW: IContextViewService = absent<IContextViewService>('IContextViewService', { layout() {} },
	'a context view is anchored to a layout this frontend has no counterpart for');

/**
 * `MatchRenderer` sets one managed hover up on the preview and another on the line number, and
 * updates each with the match's full text on every render. A terminal row has no hover state for
 * that text to appear in — the mechanism table on the functionality page says so once for every
 * hover in the fork — so the handle answers the three things its owner calls and holds nothing.
 */
export const NO_HOVER: IHoverService = absent<IHoverService>('IHoverService', {
	setupManagedHover: () => ({ show: () => { }, hide: () => { }, update: () => { }, dispose: () => { } })
} as unknown as Partial<IHoverService>, 'a terminal row has no hover state for one to appear in');

/**
 * The two `SCMActiveRepositoryController` takes beside `IStatusbarService`. Neither has a terminal
 * counterpart yet and both are reached from that one contribution: a view's badge is a number the
 * activity bar has nowhere to draw (it draws the container's keybinding digit — `§6.2`), and a
 * window title is the terminal emulator's, not ours.
 */
export const NO_ACTIVITY: IActivityService = absent<IActivityService>('IActivityService', {
	showViewActivity: () => Disposable.None
} as unknown as Partial<IActivityService>, 'a badge has nowhere to go in an activity bar that draws digits');

export const NO_TITLE: ITitleService = absent<ITitleService>('ITitleService', {
	registerVariables: () => { }
} as unknown as Partial<ITitleService>, 'the window title belongs to the terminal emulator');
