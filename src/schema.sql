PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS resources (
  id   TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_res_type
  ON resources (json_extract(json, '$.resourceType'));

CREATE INDEX IF NOT EXISTS idx_questionnaire_url_version_status
  ON resources (
    json_extract(json, '$.resourceType'),
    json_extract(json, '$.url'),
    json_extract(json, '$.version'),
    json_extract(json, '$.status')
  );

CREATE INDEX IF NOT EXISTS idx_qr_subject_identifier_status
  ON resources (
    json_extract(json, '$.resourceType'),
    json_extract(json, '$.subject.identifier.system'),
    json_extract(json, '$.subject.identifier.value'),
    json_extract(json, '$.status')
  );

CREATE INDEX IF NOT EXISTS idx_qr_questionnaire_subject_status
  ON resources (
    json_extract(json, '$.resourceType'),
    json_extract(json, '$.questionnaire'),
    json_extract(json, '$.subject.identifier.system'),
    json_extract(json, '$.subject.identifier.value'),
    json_extract(json, '$.status')
  );

CREATE INDEX IF NOT EXISTS idx_qr_authored
  ON resources (
    json_extract(json, '$.resourceType'),
    json_extract(json, '$.authored')
  );
