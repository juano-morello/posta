// T6.5.5 — Sidebar/Topbar (desktop) and BottomTabs (mobile) inspectable
// on ONE page without resizing the real browser window. AppShell's
// desktop/mobile swap (T6.3.6) is a real CSS media query keyed on the
// VIEWPORT's width, not a containing element's width — two plain divs
// side by side would both see the SAME (outer) browser viewport and
// render identically, regardless of how narrow one div's CSS width is.
// An <iframe> is a genuinely separate browsing context with its own
// viewport matching its own width/height, which is what actually makes
// both breakpoints render correctly and simultaneously — hence "framed
// viewports" in the task's own wording. Reuses /shell-preview (T6.3.6's
// own fixture route for AppShell) rather than re-composing Sidebar/
// Topbar/BottomTabs a second time here.
function FrameHeading({ children }: { children: string }) {
  return <h3 className="mb-3 font-sans text-base font-semibold">{children}</h3>;
}

export function ShellSection() {
  return (
    <div className="flex flex-wrap gap-8">
      <div>
        <FrameHeading>Desktop (≥800px)</FrameHeading>
        <div className="overflow-x-auto border border-border">
          <iframe
            data-testid="shell-frame-desktop"
            src="/shell-preview"
            width={1280}
            height={800}
            title="App shell — escritorio"
          />
        </div>
      </div>

      <div>
        <FrameHeading>Mobile (&lt;800px)</FrameHeading>
        <div className="border border-border">
          <iframe
            data-testid="shell-frame-mobile"
            src="/shell-preview"
            width={390}
            height={844}
            title="App shell — mobile"
          />
        </div>
      </div>
    </div>
  );
}
