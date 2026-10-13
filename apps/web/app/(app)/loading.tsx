/** Shown the instant a page is opened, while its data is on the way: the sidebar and header stay, only this area shows a calm placeholder. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-2 h-6 w-48" />
      <div className="skeleton mb-5 h-4 w-72" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => <div key={i} className="card min-h-[88px]"><div className="skeleton h-4 w-28" /><div className="skeleton mt-3 h-7 w-20" /></div>)}
      </div>
    </div>
  );
}
