import Sidebar from '@/components/Sidebar';

// Shared "coming soon" page used by routes we haven't built yet.
// Lets us wire up real sidebar navigation today without 404s,
// then swap in real pages later without touching the sidebar.
export default function StubPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 p-8">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="text-gray-600 mt-2">{description}</p>

        <div className="bg-white rounded-xl shadow p-8 mt-8 text-center">
          <p className="text-gray-400 text-lg">
            Coming soon
          </p>
        </div>
      </section>
    </main>
  );
}
