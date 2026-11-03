'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TOUR, TOUR_EVENT, markTourDone, tourDone } from '@/lib/tour';

export function Tour() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    const start = () => { setI(0); setOpen(true); };
    window.addEventListener(TOUR_EVENT, start);
    if (!tourDone()) {
      const t = window.setTimeout(start, 400);
      return () => {
        window.clearTimeout(t);
        window.removeEventListener(TOUR_EVENT, start);
      };
    }
    return () => window.removeEventListener(TOUR_EVENT, start);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setI(n => Math.min(TOUR.length - 1, n + 1));
      if (e.key === 'Enter') {
        if (i >= TOUR.length - 1) close();
        else setI(n => n + 1);
      }
      if (e.key === 'ArrowLeft') setI(n => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, i]);

  function close() {
    markTourDone();
    setOpen(false);
  }

  function next() {
    if (i >= TOUR.length - 1) {
      close();
      return;
    }
    setI(n => n + 1);
  }

  if (!open) return null;
  const step = TOUR[i];
  const last = i === TOUR.length - 1;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="tour-card">
        <p className="card-kicker">Step {i + 1} of {TOUR.length}</p>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {TOUR.map((s, n) => <i key={s.id} className={n === i ? 'on' : ''} />)}
        </div>
        <div className="tour-actions">
          <button className="btn secondary" type="button" onClick={close}>Skip</button>
          <div className="row">
            {step.href && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => { if (step.href) router.push(step.href); }}
              >
                Open this
              </button>
            )}
            <button className="btn" type="button" onClick={next}>
              {last ? 'Start the work' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
