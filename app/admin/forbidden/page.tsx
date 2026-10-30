import Link from 'next/link';

export default function AdminForbiddenPage() {
  return <main className="grid min-h-screen place-items-center px-5 py-12">
    <section className="card w-full max-w-lg p-8 text-center">
      <div className="eyebrow">Administrator access</div>
      <h1 className="serif mt-3 text-4xl">Access not permitted</h1>
      <p className="muted mt-4 leading-7">This account is signed in but does not have administrator permission.</p>
      <Link href="/" className="btn btn-outline mt-6">Back to home</Link>
    </section>
  </main>;
}
