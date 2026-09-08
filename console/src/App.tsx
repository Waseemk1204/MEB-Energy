import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './store/AuthProvider';
import { Shell } from './ui/Shell';
import { Login } from './pages/Login';
import { Batteries } from './pages/Batteries';
import { Battery } from './pages/Battery';
import { Audit } from './pages/Audit';
import { Support } from './pages/Support';
import { Users } from './pages/Users';
import { Devices } from './pages/Devices';
import { Companies } from './pages/Companies';
import { AcceptInvite } from './pages/AcceptInvite';

/**
 * Routing.
 *
 * Signed out, every path renders the sign-in screen — there is no partially
 * rendered console behind a modal, because a page that mounts and then fails
 * its requests looks like a broken product rather than a locked one.
 */
export function App() {
  const { user } = useAuth();

  // Accepting an invitation is the one screen a signed-out person is meant to
  // reach, so it is routed before the sign-in guard rather than behind it.
  return (
    <Routes>
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="*" element={<SignedIn signedIn={user !== null} />} />
    </Routes>
  );
}

function SignedIn({ signedIn }: { signedIn: boolean }) {
  if (!signedIn) return <Login />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/batteries" element={<Batteries />} />
        <Route path="/batteries/:id" element={<Battery />} />
        <Route path="/audit" element={<Audit />} />

        <Route path="/support" element={<Support />} />
        <Route path="/users" element={<Users />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/companies" element={<Companies />} />

        <Route path="*" element={<Navigate to="/batteries" replace />} />
      </Route>
    </Routes>
  );
}
