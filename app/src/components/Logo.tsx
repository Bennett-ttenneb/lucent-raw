/**
 * The Lucent Raw mark: the "L" folded ribbon on its dark rounded square, the same picture as the app icon (public/brand/app-icon.png,
 * made from the brand artwork in design/brand/new). It is a tile with its own background, so it reads the same in both themes.
 */
export function Monogram({ height = 30, className }: { height?: number; className?: string }) {
  return <img className={className} src="/brand/app-icon.png" height={height} width={height} alt="" aria-hidden draggable={false} />
}

/**
 * The name: the supplied "LUCENT RAW" lettering (public/brand/name.png, white on a clear background, from design/brand/new/brand name.svg).
 * It is white, so the light theme turns it black with a filter (see .wordmark in app.css). Only for the eye: the name for a screen
 * reader is the page's heading.
 */
export function Wordmark({ className }: { className?: string }) {
  return <img className={className ? `wordmark ${className}` : 'wordmark'} src="/brand/name.png" width={188} height={15} alt="" aria-hidden draggable={false} />
}
