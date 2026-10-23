import { Button, Stack, Text, Title } from '@mantine/core';
import { useEffect } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';

import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
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

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function RequireRole({ role }: { role: 'client' | 'analyst' }) {
  const { user } = useAuth();
  if (user && user.role !== role) return <Navigate to={user.role === 'analyst' ? '/queue' : '/'} replace />;
  return <Outlet />;
}

function NotFoundPage() {
  return (
    <Stack align="center" py={80} gap="sm" ta="center">
      <Title order={1} fz={64} c="brand.6">
        404
      </Title>
      <Text c="dimmed">Такой страницы нет</Text>
      <Button component={Link} to="/" mt="md">
        На главную
      </Button>
    </Stack>
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
