import { redirect } from 'next/navigation';

// Server-side redirect: visiting "/" sends you to "/dashboard".
// Middleware will then either let you through (if cookie valid) or
// bounce you to /login.
export default function Home() {
  redirect('/dashboard');
}
