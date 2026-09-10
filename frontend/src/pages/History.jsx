import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api/client.js";
import ImageCard from "../components/ImageCard.jsx";

export default function History() {
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState("");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [generations, setGenerations] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [upscalerAvailable, setUpscalerAvailable] = useState(false);

  const searchTimer = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listGenerations({
        channelId: channelId === "" ? undefined : channelId,
        search: search.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limit: 100,
      });
      setGenerations(data);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [channelId, search, dateFrom, dateTo]);

  useEffect(() => {
    api
      .listChannels()
      .then(setChannels)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(load, 300);
    return () => clearTimeout(searchTimer.current);
  }, [load]);

  const handleRename = async (id, name) => {
    try {
      await api.renameGeneration(id, name);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRegenerate = async (id, body = {}) => {
    try {
      await api.regenerate(id, body);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleHide = async (id) => {
    try {
      await api.patchGeneration(id, { hidden: true });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpscale = async (id, scale) => {
    try {
      await api.upscaleGeneration(id, scale);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    api
      .upscaleStatus()
      .then((s) => setUpscalerAvailable(Boolean(s.available)))
      .catch(() => setUpscalerAvailable(false));
  }, []);

  const handleSaveToChannel = async (id, targetChannelId) => {
    try {
      await api.saveGenerationAsAsset(id, targetChannelId);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section>
      <h1>History</h1>
      <div className="form-row">
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">All channels</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or prompt…"
        />
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <span className="muted">→</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : generations.length === 0 ? (
        <p className="muted">No generations match.</p>
      ) : (
        <>
          <p className="muted small">
            Showing {generations.length} result{generations.length === 1 ? "" : "s"} · est. spend $
            {generations.reduce((sum, g) => sum + (g.cost_usd || 0), 0).toFixed(2)}
          </p>
          <div className="grid images">
            {generations.map((generation) => (
              <ImageCard
                key={generation.id}
                generation={generation}
                channels={channels}
              onRename={handleRename}
              onSaveToChannel={handleSaveToChannel}
              onRegenerate={handleRegenerate}
              onHide={handleHide}
              onUpscale={upscalerAvailable ? handleUpscale : null}
            />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
