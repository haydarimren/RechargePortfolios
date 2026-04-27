"use client";

/**
 * Encryption onboarding page. Reached via redirect from EnrollmentGate
 * for any signed-in user who hasn't enrolled yet. Job:
 *
 *   1. Generate the user's identity keypair + master secret + a
 *      non-extractable localWrapKey for this browser.
 *   2. Show the 12-word recovery phrase exactly once with a confirmation
 *      gate (user retypes 3 random words).
 *   3. Call `enrollEncryption` to land the public key + wrapped private
 *      key in Firestore and seed local IndexedDB state.
 *   4. Redirect home.
 *
 * No password prompt: the daily login flow uses silent auto-unlock from
 * IndexedDB. The recovery phrase is the user's only piece of recoverable
 * secret; it's only needed when switching devices or after browser-data
 * clear.
 */

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase";
import { enrollEncryption, getEncryptionStatus } from "@/lib/encryption-setup";
import { generateMasterSecret } from "@/lib/crypto-client";
import { seedToPhrase } from "@/lib/recovery-phrase";
import { ThemeToggle } from "@/lib/theme";

/** Pick 3 distinct random positions in [0, 11]. */
function pickQuizPositions(): [number, number, number] {
  const all = Array.from({ length: 12 }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return [all[0], all[1], all[2]].sort((a, b) => a - b) as [
    number,
    number,
    number,
  ];
}

export default function EncryptionOnboardingPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // Show-the-phrase state. The seed is generated locally so the master
  // secret never leaves the browser. The same exact bytes get passed to
  // enrollEncryption so the displayed phrase is the one that's actually
  // wrapped and persisted.
  const [phrase, setPhrase] = useState<string | null>(null);
  const [seed, setSeed] = useState<Uint8Array | null>(null);
  const [quizPositions] = useState<[number, number, number]>(() =>
    pickQuizPositions(),
  );
  const [quizAnswers, setQuizAnswers] = useState<[string, string, string]>([
    "",
    "",
    "",
  ]);

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Auth gate + master-secret generation.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setAuthChecked(true);
      setUser(u);
      if (!u) {
        router.replace("/login");
        return;
      }
      // If the user already enrolled (e.g. they navigated here directly),
      // bounce them back to the home page rather than re-enrolling and
      // wiping their existing key state.
      const status = await getEncryptionStatus(u.uid);
      if (status.kind !== "uninitialized") {
        router.replace("/");
        return;
      }
      const generated = generateMasterSecret();
      setSeed(generated);
      setPhrase(await seedToPhrase(generated));
    });
    return () => unsub();
  }, [router]);

  const phraseWords = useMemo(
    () => (phrase ? phrase.split(" ") : []),
    [phrase],
  );

  const quizSatisfied = useMemo(() => {
    if (!phrase) return false;
    return quizPositions.every((pos, i) =>
      quizAnswers[i].trim().toLowerCase() === phraseWords[pos],
    );
  }, [phrase, phraseWords, quizPositions, quizAnswers]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !phrase || !seed) return;
    if (!quizSatisfied) {
      setError("Confirm the recovery phrase first.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await enrollEncryption(user.uid, seed);
      router.replace("/");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to set up encryption",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!authChecked || !phrase) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-fg-dim">
        Loading…
      </div>
    );
  }

  return (
    <div className="relative min-h-screen flex flex-col">
      <header className="px-6 lg:px-10 pt-6">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium tracking-tight">Recharge</div>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-lg animate-fade-up space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight mb-2">
              Set up encryption
            </h1>
            <p className="text-sm text-fg-dim">
              Your portfolio is encrypted on this device before it reaches our
              servers. Even we can&apos;t read it. The recovery phrase below is
              the only way to get back in if you switch devices or clear your
              browser data.
            </p>
          </div>

          {error && (
            <div className="border border-neg/40 bg-neg/10 text-neg text-sm rounded-md p-3">
              {error}
            </div>
          )}

          <section className="card p-6 space-y-4">
            <div>
              <div className="label mb-2">Your recovery phrase</div>
              <p className="text-xs text-fg-dim mb-3">
                Write these 12 words down on paper. Store them somewhere safe.
                Don&apos;t screenshot, don&apos;t email yourself. We can&apos;t
                recover this for you.
              </p>
              <div className="grid grid-cols-3 gap-2 num">
                {phraseWords.map((w, i) => (
                  <div
                    key={i}
                    className="border border-line rounded-md px-2 py-1.5 text-sm bg-bg-2"
                  >
                    <span className="text-fg-fade text-xs mr-1">
                      {i + 1}.
                    </span>
                    {w}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <form onSubmit={handleSubmit} className="card p-6 space-y-4">
            <div>
              <div className="label mb-2">Confirm you wrote it down</div>
              <p className="text-xs text-fg-dim mb-3">
                Enter the words at positions {quizPositions[0] + 1},{" "}
                {quizPositions[1] + 1}, and {quizPositions[2] + 1}.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {quizPositions.map((pos, i) => (
                  <input
                    key={pos}
                    type="text"
                    placeholder={`Word ${pos + 1}`}
                    value={quizAnswers[i]}
                    onChange={(e) => {
                      const next = [...quizAnswers] as [
                        string,
                        string,
                        string,
                      ];
                      next[i] = e.target.value;
                      setQuizAnswers(next);
                    }}
                    className="field"
                    autoComplete="off"
                    required
                  />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={!quizSatisfied || submitting}
              className="btn-primary w-full disabled:opacity-50"
            >
              {submitting ? "Setting up…" : "Enable encryption"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
