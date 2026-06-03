import Link from 'next/link';
import Sidebar from '@/components/Sidebar';

const SECTIONS = [
  {
    title: 'Users',
    description: 'Create, edit, deactivate, and assign roles to users.',
    href: '/admin/users',
  },
  {
    title: 'Edit Requests',
    description: 'Review user requests to edit sealed invoices.',
    href: '/admin/edit-requests',
  },
  {
    title: 'Cards',
    description: 'Manage company cards and assign them to users.',
    href: '/cards',
  },
  {
    title: 'Stores',
    description: 'Manage internal stores for Stationary and IT Equipment allocations.',
    href: '/admin/stores',
  },
  {
    title: 'Categories',
    description: 'Manage the FFG chart-of-accounts categories used by every invoice.',
    href: '/admin/categories',
  },
  {
    title: 'Audit Logs',
    description: 'Immutable record of every important action across the system.',
    href: '/admin/audit-logs',
  },
];

export default function AdminLandingPage() {
  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
        <h1 className="text-3xl font-bold">Admin</h1>
        <p className="text-gray-600 mt-1 mb-6">
          Manage users, cards, and edit-request workflows
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              className="bg-white rounded-xl shadow p-6 hover:shadow-lg transition block"
            >
              <h2 className="text-xl font-semibold">{s.title}</h2>
              <p className="text-gray-600 text-sm mt-1">{s.description}</p>
              <p className="text-sm text-black mt-3 font-medium">
                Open →
              </p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
