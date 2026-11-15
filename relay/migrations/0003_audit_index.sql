CREATE INDEX audit_peer ON audit_log (peer_hash, id);
CREATE INDEX audit_event ON audit_log (event, id);
