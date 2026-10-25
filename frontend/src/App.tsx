import { Button } from '@mantine/core';
import { useEffect } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';

import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Empty } from './components/States';
import { FullScreenLoader } from './components/ui';
import { ApplicationPage } from './pages/ApplicationPage';
import { ApplicationWizardPage } from './pages/ApplicationWizardPage';
import { ApplicationsPage } from './pages/ApplicationsPage';
import { ContractPage } from './pages/ContractPage';
import { HomePage } from './pages/HomePage';
import { LoanPage, LoansPage } from './pages/LoansPage';
import { LoginPage } from './pages/LoginPage';
import { MatchPage } from './pages/MatchPage';
import { PolicyPage } from './pages/PolicyPage';
import { ProfilePage } from './pages/ProfilePage';
import { QueuePage } from './pages/QueuePage';
import { SystemPage } from './pages/SystemPage';

/** Без входа — на страницу входа; запрошенная страница уходит с ней и откроется после входа. */
function RequireAuth() {
  const { user, loading, signedOut } = useAuth();
  const location = useLocation();
  if (loading) return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" replace state={signedOut ? undefined : { from: location }} />;
  return <Outlet />;
}

function RequireRole({ role }: { role: 'client' | 'analyst' }) {
  const { user } = useAuth();
  if (user && user.role !== role) return <Navigate to={user.role === 'analyst' ? '/queue' : '/'} replace />;
  return <Outlet />;
}

/** Нет такой страницы — иллюстрация и путь назад. */
function NotFoundPage() {
  return (
    <section className="potok-panel">
      <Empty
        art="list"
        title="Такой страницы нет"
        text="Возможно, ссылка устарела или в ней опечатка."
        action={
          <Button component={Link} to="/" size="lg" variant="default">
            На главную
          </Button>
        }
      />
    </section>
  );
}

/** Новая страница открывается с начала, а не с прокрутки предыдущей. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <AppRoutes />
    </>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route element={<RequireRole role="client" />}>
            <Route index element={<HomePage />} />
            <Route path="match" element={<MatchPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="applications/:id/edit" element={<ApplicationWizardPage />} />
            <Route path="loans" element={<LoansPage />} />
            <Route path="loans/:id" element={<LoanPage />} />
          </Route>
          <Route element={<RequireRole role="analyst" />}>
            <Route path="queue" element={<QueuePage />} />
            <Route path="policy" element={<PolicyPage />} />
            <Route path="system" element={<SystemPage />} />
          </Route>
          <Route path="profile" element={<ProfilePage />} />
          <Route path="applications/:id" element={<ApplicationPage />} />
          <Route path="applications/:id/contract" element={<ContractPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
