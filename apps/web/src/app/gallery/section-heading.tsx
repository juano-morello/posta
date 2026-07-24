// PR #2 review (MEDIUM/DRY) — this exact one-line heading was defined
// independently, identically, in three gallery section files (shadcn/
// honesty/shell). Extracted once here so a future style change (or a
// fourth section) has one place to edit, not three copies to keep in
// sync by hand.
export function SectionHeading({ children }: { children: string }) {
  return <h3 className="mb-3 font-sans text-base font-semibold">{children}</h3>;
}
