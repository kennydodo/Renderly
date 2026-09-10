import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { api } from "../api/client.js";

export default function ChannelList() {
  const [channels, setChannels] = useState([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setChannels(await api.listChannels());
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await api.createChannel({ name: name.trim(), description: description.trim() });
      setName("");
      setDescription("");
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section>
      <h1>Channels</h1>
      <p className="muted">
        Each channel keeps its own reference assets and generated images.
      </p>

      <form className="card form-row" onSubmit={handleCreate}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Channel name"
          maxLength={120}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          maxLength={500}
        />
        <button type="submit" disabled={!name.trim()}>
          Create channel
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : channels.length === 0 ? (
        <p className="muted">No channels yet — create one above.</p>
      ) : (
        <div className="grid cards">
          {channels.map((channel) => (
            <div key={channel.id} className="card channel-card">
              <Link to={`/channels/${channel.id}`} className="channel-link">
                <h2>{channel.name}</h2>
                <p className="muted">{channel.description || "No description"}</p>
              </Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
