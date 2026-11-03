export function Steps({
  items,
  now,
}: {
  items: string[];
  now: number;
}) {
  return (
    <ol className="steps" aria-label="What happens">
      {items.map((label, i) => {
        const n = i + 1;
        const state = n < now ? 'done' : n === now ? 'now' : 'todo';
        return (
          <li key={label} className={state}>
            <span className="step-n" aria-hidden="true">{n}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
