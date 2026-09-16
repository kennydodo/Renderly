import { NavLink, Route, Routes } from "react-router-dom";

import ChannelList from "./pages/ChannelList.jsx";
import ChannelWorkspace from "./pages/ChannelWorkspace.jsx";
import History from "./pages/History.jsx";
import Settings from "./pages/Settings.jsx";

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          Renderly
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Channels
          </NavLink>
          <NavLink to="/history">History</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<ChannelList />} />
          <Route path="/channels/:channelId" element={<ChannelWorkspace />} />
          <Route path="/channels/:channelId/projects/:projectId" element={<ChannelWorkspace />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
