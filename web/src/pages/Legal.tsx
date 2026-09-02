/* Legal pages (/privacy, /terms): public pages linked from the login page footer.
   This is a self-hosted context: the operator is the organization that
   deploys the software, and this text is the default policy that ships
   with it. State facts honestly: what data is stored, when data leaves
   the server, and what deletion actually does. */
import { Link } from "@tanstack/react-router";
import { S } from "../i18n";

type LegalSection = {
  h: string;
  body: readonly string[];
  bullets?: readonly string[];
};
type LegalDocData = {
  title: string;
  note: string;
  sections: readonly LegalSection[];
};

function LegalPage({ doc }: { doc: LegalDocData }) {
  return (
    <div className="min-h-screen px-4 py-14">
      <div className="mx-auto w-full max-w-xl">
        <Link
          to="/login"
          className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        >
          {S.legal.backToSignIn}
        </Link>
        <h1
          className="mt-6 text-3xl text-white"
          style={{ fontFamily: "var(--font-brand)", letterSpacing: "0.04em" }}
        >
          {doc.title}
        </h1>
        <p className="mt-3 text-xs text-neutral-600">{doc.note}</p>
        <div className="mt-9 space-y-7">
          {doc.sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-sm font-semibold text-neutral-200">{s.h}</h2>
              {s.body.map((p, i) => (
                <p key={i} className="mt-2 text-sm leading-relaxed text-neutral-400">
                  {p}
                </p>
              ))}
              {s.bullets && (
                <ul className="mt-2 space-y-1.5">
                  {s.bullets.map((b, i) => (
                    <li
                      key={i}
                      className="relative pl-4 text-sm leading-relaxed text-neutral-400"
                    >
                      <span className="absolute left-0 text-neutral-600">–</span>
                      {b}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Privacy() {
  return <LegalPage doc={S.legal.privacy} />;
}
export function Terms() {
  return <LegalPage doc={S.legal.terms} />;
}
