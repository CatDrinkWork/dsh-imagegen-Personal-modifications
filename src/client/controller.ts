/**
 * Image-gen panel controller: the single owner of the workbench view state.
 * Framework-free so the DOM mounts and the React panels share one tiny
 * subscription surface. The state lives only for the browser session.
 *
 * `activeView` is the three-way selector (session / image / video); `panelOpen`
 * is kept as a derived getter so older callers (mount, sidebar, smoke asserts)
 * continue to work unchanged.
 */

/** Which center-column view the controller is showing. */
export type ImageGenView = 'session' | 'image' | 'video'

/** Immutable controller snapshot for UI subscriptions. */
export interface ImageGenControllerSnapshot {
  /** The active workbench view. */
  activeView: ImageGenView
  /** Derived: any non-session view means a workbench panel is open. */
  panelOpen: boolean
}

/** The panel state owner the sidebar entry toggles and the view renders from. */
export class ImageGenController {
  private activeView: ImageGenView = 'session'
  private listeners = new Set<() => void>()

  getSnapshot(): ImageGenControllerSnapshot {
    return { activeView: this.activeView, panelOpen: this.activeView !== 'session' }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Switch to a specific view (no-op when already there). */
  setView(view: ImageGenView): void {
    if (this.activeView === view) return
    this.activeView = view
    this.notify()
  }

  /** Show the image workbench. */
  openImage(): void {
    this.setView('image')
  }

  /** Show the video workbench. */
  openVideo(): void {
    this.setView('video')
  }

  /** Back-compat alias: open the image workbench. */
  open(): void {
    this.openImage()
  }

  /** Return to the plain session view. */
  close(): void {
    this.setView('session')
  }

  /** Toggle between the image workbench and the session view. */
  toggle(): void {
    if (this.activeView === 'session') this.openImage()
    else this.close()
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
