import { useEffect, useRef, useState } from "react";
import "./app.css";
import { getCurrentCrew, getMyJobs, logout, updateJobStatus, uploadJobPhoto } from "./lib/api.js";
import { navigateTo } from "./lib/navigate.js";
import { buildMultiStopUrl, openMultiJobRoute } from "./lib/routing.js";

/* =========================================================
   DEMO DATA
========================================================= */

const CREWS = [
  {
    id: "C001",
    name: "Crew Alpha-3",
    lead: "Rajesh Kumar",
    role: "Crew Lead",
    shift: "06:00–18:00",
    skills: ["HV", "Underground"],
  },
  {
    id: "C002",
    name: "Crew Beta-1",
    lead: "Amit Sharma",
    role: "Field Technician",
    shift: "06:00–18:00",
    skills: ["MV", "Recloser"],
  },
  {
    id: "C003",
    name: "Crew Gamma-2",
    lead: "Priya Singh",
    role: "Field Technician",
    shift: "06:00–18:00",
    skills: ["HV", "Transformer"],
  },
  {
    id: "C004",
    name: "Crew Delta-4",
    lead: "Suresh Patel",
    role: "Crew Lead",
    shift: "18:00–06:00",
    skills: ["MV", "Fuse"],
  },
  {
    id: "C005",
    name: "Crew Echo-1",
    lead: "Meena Rao",
    role: "Field Technician",
    shift: "18:00–06:00",
    skills: ["MV", "LV"],
  },
];

const CREW_STATUSES = {
  "Crew Alpha-3": "On Site",
  "Crew Beta-1": "En Route",
  "Crew Gamma-2": "Available",
  "Crew Delta-4": "On Site",
  "Crew Echo-1": "Offline",
};

const SAFETY_ITEMS = [
  "Line confirmed de-energised",
  "PPE worn",
  "Work area barricaded",
  "Permit verified",
];

function severityClass(severity) {
  const normalized = String(severity ?? "Medium").toLowerCase();
  return ["critical", "high", "medium", "low"].includes(normalized)
    ? normalized
    : "medium";
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

function normalizeOmsJob(job) {
  return {
    id: job.id ?? job.jobId,
    title: job.title ?? job.name ?? "Priority outage",
    address: job.address ?? job.location ?? "Location unavailable",
    feeder: job.feeder ?? job.feederId ?? "—",
    severity: job.severity ?? "Medium",
    priority: job.priority ?? "Urgent",
    customers: job.customers ?? job.affectedCustomers ?? 0,
    status: job.status ?? "Pending Acceptance",
    distance: job.distance ?? (job.distanceKm ? `${job.distanceKm} km` : "—"),
    eta: job.eta ?? "—",
    assignedCrewId: job.assignedCrewId ?? job.crewId ?? null,
    assignedDistance: job.assignedDistance ?? job.distance ?? "Nearest available",
  };
}

export default function App() {
  const role = "crew";
  const [authenticated, setAuthenticated] = useState(false);
  const [crew, setCrew] = useState(() => CREWS.find((item) => item.id === "C003"));
  const [jobs, setJobs] = useState([]);
  const [omsSource, setOmsSource] = useState("syncing");
  const online = useOnline();
  const [queuedUpdates, setQueuedUpdates] = useState(() => JSON.parse(localStorage.getItem("oms-status-queue") || "[]"));

  useEffect(() => {
    localStorage.setItem("oms-status-queue", JSON.stringify(queuedUpdates));
    if (!online || !queuedUpdates.length) return;
    Promise.all(queuedUpdates.map(({ id, status, location }) => updateJobStatus(id, status, location)))
      .then(() => setQueuedUpdates([]))
      .catch(() => {});
  }, [online, queuedUpdates]);

  useEffect(() => () => {
    if (navigator.mediaDevices?.getUserMedia) {
      const tracks = document.querySelectorAll("video");
      tracks.forEach((video) => {
        const stream = video.srcObject;
        stream?.getTracks().forEach((track) => track.stop());
      });
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    getCurrentCrew()
      .then((currentCrew) => setCrew(currentCrew))
      .catch(() => {});

    getMyJobs()
      .then((myJobs) => {
        setJobs(myJobs.map(normalizeOmsJob));
        setOmsSource("oms");
      })
      .catch(() => setOmsSource("unavailable"));
  }, [authenticated]);

  const updateJob = (id, changes) => {
    setJobs((current) => {
      const updatedJobs = current.map((job) =>
        job.id === id ? { ...job, ...changes } : job
      );
      const updatedJob = updatedJobs.find((job) => job.id === id);
      if (changes.status) {
        if (online) updateJobStatus(id, changes.status, changes.location ?? {}).catch(() => {});
        else setQueuedUpdates((pending) => [...pending, { id, status: changes.status, location: changes.location ?? {} }]);
      }
      return updatedJobs;
    });
  };

  if (!crew) {
    return (
      <main className="app-shell">
        <div className="loading-state">Loading your field workspace...</div>
      </main>
    );
  }

  /* -------------------------------------------------------
     CREW APP
  ------------------------------------------------------- */

  if (role === "crew" && crew) {
    if (!authenticated) {
      return <CrewEmailLogin onSuccess={() => setAuthenticated(true)} />;
    }

    return (
      <CrewLayout
        crew={crew}
        jobs={jobs}
        onUpdateJob={updateJob}
        omsSource={omsSource}
        online={online}
        queuedUpdates={queuedUpdates}
        onLogout={() => {
          logout();
          setAuthenticated(false);
        }}
      />
    );
  }

  /* -------------------------------------------------------
     LEADER APP
  ------------------------------------------------------- */

  return (
    <LeaderLayout
      crew={crew}
      jobs={jobs}
      omsSource={omsSource}
      onLogout={() => {
        logout();
      }}
    />
  );
}

/* =========================================================
  CREW LOGIN
========================================================= */

function CrewLogin({ onSelect, onBack }) {
  const technicians = CREWS.filter(
    (crew) => crew.role === "Field Technician"
  );

  return (
    <div className="app-shell">
      <div className="login-screen">
        <button className="back-button" onClick={onBack}>
          ← Back
        </button>

        <div className="brand">
          <div className="brand-icon">⚡</div>

          <div>
            <h1>
              OMS <span>Crew</span>
            </h1>

            <p>Field Technician Login</p>
          </div>
        </div>

        <div className="login-card">
          <h2>Select your crew</h2>

          <p className="muted">
            Select the field unit assigned to you.
          </p>

          {technicians.map((crew) => (
            <button
              key={crew.id}
              className="crew-login-card"
              onClick={() => onSelect(crew)}
            >
              <div className="avatar">
                {crew.name.charAt(5)}
              </div>

              <div>
                <strong>{crew.name}</strong>

                <span>{crew.lead}</span>

                <small>
                  {crew.id} · {crew.role}
                </small>
              </div>

              <b>→</b>
            </button>
          ))}
        </div>

        <div className="login-footer">
          Secure field session · Offline capable
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   LEADER LOGIN
========================================================= */

function LeaderLogin({ onSelect, onBack }) {
  const leaders = CREWS.filter(
    (crew) => crew.role === "Crew Lead"
  );

  return (
    <div className="app-shell">
      <div className="login-screen">
        <button className="back-button" onClick={onBack}>
          ← Back
        </button>

        <div className="brand">
          <div className="brand-icon">⚡</div>

          <div>
            <h1>
              OMS <span>Leader</span>
            </h1>

            <p>Crew Leader Login</p>
          </div>
        </div>

        <div className="login-card">
          <h2>Select leader account</h2>

          <p className="muted">
            Access the field operations dashboard.
          </p>

          {leaders.map((crew) => (
            <button
              key={crew.id}
              className="crew-login-card"
              onClick={() => onSelect(crew)}
            >
              <div className="avatar leader-avatar">
                {crew.name.charAt(5)}
              </div>

              <div>
                <strong>{crew.name}</strong>

                <span>{crew.lead}</span>

                <small>
                  {crew.id} · Crew Leader
                </small>
              </div>

              <b>→</b>
            </button>
          ))}
        </div>

        <div className="login-footer">
          Operations Control · UPCL Ganga Corridor
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   CREW LAYOUT
========================================================= */

function CrewLayout({ crew, jobs, onUpdateJob, omsSource, online, queuedUpdates, onLogout }) {
  const [tab, setTab] = useState("jobs");
  const [selectedMapJobId, setSelectedMapJobId] = useState(null);

  const openJobOnMap = (job) => {
    setSelectedMapJobId(job.id);
    setTab("map");
  };

  return (
    <div className="phone-app">
      <Header
        crew={crew}
        title="Field Crew"
        online={online}
        onLogout={onLogout}
      />

      <main className="app-content">
        {tab === "jobs" && (
          <CrewJobs
            jobs={jobs}
            crew={crew}
            onUpdate={onUpdateJob}
            omsSource={omsSource}
            online={online}
            queuedUpdates={queuedUpdates}
            onNavigate={openJobOnMap}
          />
        )}

        {tab === "map" && <MapView jobs={jobs} selectedJobId={selectedMapJobId} />}

        {tab === "me" && (
          <Profile
            crew={crew}
            onLogout={onLogout}
          />
        )}
      </main>

      <BottomNavigation
        tab={tab}
        setTab={setTab}
        items={[
          ["jobs", "Jobs", "📋"],
          ["map", "Map", "🗺️"],
          ["me", "Me", "👤"],
        ]}
      />
    </div>
  );
}

/* =========================================================
   CREW JOBS
========================================================= */

function CrewJobs({ jobs, crew, onUpdate, omsSource, online, queuedUpdates, onNavigate }) {
  const [jobFilter, setJobFilter] = useState("Assigned");
  const visibleJobs = jobs.filter(
    (job) => !job.assignedCrewId || job.assignedCrewId === crew.id
  );
  const urgentJobs = visibleJobs.filter(
    (job) => String(job.priority).toLowerCase() === "urgent"
  );
  const activeJobs = visibleJobs.filter(
    (job) => !["work complete", "completed", "closed"].includes(String(job.status).toLowerCase())
  );
  const filteredJobs = jobFilter === "Urgent"
    ? urgentJobs
    : jobFilter === "Active"
      ? activeJobs
      : visibleJobs;
  const pendingJobs = filteredJobs.filter(
    (job) => job.status === "Pending Acceptance"
  );

  return (
    <>
      <PageHeader
        title="My Jobs"
        subtitle={`${visibleJobs.length} assigned outages · ${omsSource === "oms" ? "Live OMS feed" : "Demo OMS feed"}`}
      />

      {!online && <div className="offline-banner">Offline - changes will sync</div>}
      {queuedUpdates.length > 0 && <div className="sync-queue">{queuedUpdates.length} pending update(s)</div>}

      <div className="summary-row">
        <SummaryCard
          label="Assigned"
          value={visibleJobs.length}
          active={jobFilter === "Assigned"}
          onClick={() => setJobFilter("Assigned")}
        />

        <SummaryCard
          label="Urgent"
          value={
            urgentJobs.length
          }
          active={jobFilter === "Urgent"}
          onClick={() => setJobFilter("Urgent")}
        />

        <SummaryCard
          label="Active"
          value={
            activeJobs.length
          }
          active={jobFilter === "Active"}
          onClick={() => setJobFilter("Active")}
        />
      </div>

      {pendingJobs.length > 0 && (
        <>
          <div className="section-title pending-title">Pending acceptance</div>
          <div className="pending-task-note">
            OMS assigned this task to you as the nearest ready crew.
          </div>
        </>
      )}

      <div className="section-title">
        {jobFilter} outages
      </div>

      <div className="job-list">
        {filteredJobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onUpdate={onUpdate}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      {filteredJobs.length === 0 && (
        <div className="none">No {jobFilter.toLowerCase()} jobs found.</div>
      )}
    </>
  );
}

/* =========================================================
   JOB CARD
========================================================= */

function JobCard({ job, onUpdate, onNavigate }) {
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [showSafety, setShowSafety] = useState(false);
  const [checked, setChecked] = useState({});
  const [photos, setPhotos] = useState([]);
  const [assetId, setAssetId] = useState("");
  const [assetMessage, setAssetMessage] = useState("");
  const [photoMessage, setPhotoMessage] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const videoRef = useRef(null);

  const nextStatus = {
    "Pending Acceptance": "Acknowledged",
    Acknowledged: "En Route",
    "En Route": "On Site",
    "On Site": "Work Started",
    "Work Started": "Work Complete",
  };

  const advance = async () => {
    const next = nextStatus[job.status];
    if (!next || updating) return;

    if (job.status === "On Site" && !SAFETY_ITEMS.every((_, index) => checked[index])) {
      setShowSafety(true);
      return;
    }
    setUpdating(true);
    const location = await getLocation();
    onUpdate(job.id, {
      status: next,
      location,
      acceptance: job.status === "Pending Acceptance" ? "Accepted" : job.acceptance,
    });
    setUpdating(false);
  };

  const addPhotos = async (event) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setPhotoMessage("Uploading photo...");
    try {
      const uploaded = await Promise.all(files.map(async (file) => {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("Could not read photo"));
          reader.readAsDataURL(file);
        });
        await uploadJobPhoto(job.id, dataUrl, await getLocation(), assetId ? `Asset: ${assetId}` : undefined);
        return { url: URL.createObjectURL(file), file };
      }));
      setPhotos((current) => [...current, ...uploaded]);
      setPhotoMessage(`${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} stored.`);
    } catch (error) {
      setPhotoMessage(error?.message || "Photo upload failed.");
    } finally {
      event.target.value = "";
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
    }
    setCameraStream(null);
    setCameraOpen(false);
  };

  const openQrCamera = async () => {
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
      setAssetMessage("Camera QR scanning is unavailable in this browser. Upload an image instead.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      setCameraStream(stream);
      setCameraOpen(true);
      setAssetMessage("Camera ready. Point it at the QR code and press Capture.");
    } catch {
      setAssetMessage("Camera permission was denied. Upload an image instead.");
    }
  };

  const captureQrFromCamera = async () => {
    if (!videoRef.current || !cameraStream) return;

    const video = videoRef.current;
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      setAssetMessage("Camera frame could not be processed. Try again.");
      return;
    }

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    try {
      const result = await detector.detect(canvas);
      if (!result.length) {
        setAssetMessage("No QR code found in the camera frame.");
        return;
      }
      setAssetId(result[0].rawValue);
      setAssetMessage("QR asset detected from camera.");
      stopCamera();
    } catch {
      setAssetMessage("Camera QR detection failed. Try again or upload an image.");
    }
  };

  const scanQrImage = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !("BarcodeDetector" in window)) {
      setAssetMessage("QR camera scanning is unavailable. Enter the asset ID instead.");
      return;
    }
    try {
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      const result = await detector.detect(await createImageBitmap(file));
      if (!result.length) throw new Error("No QR code");
      setAssetId(result[0].rawValue);
      setAssetMessage("QR asset detected.");
    } catch {
      setAssetMessage("No readable QR code found.");
    }
  };

  const readNfc = async () => {
    if (!("NDEFReader" in window)) {
      setAssetMessage("NFC is unavailable in this browser.");
      return;
    }
    try {
      const reader = new window.NDEFReader();
      await reader.scan();
      reader.onreading = ({ serialNumber }) => {
        setAssetId(serialNumber);
        setAssetMessage("NFC asset detected.");
      };
    } catch {
      setAssetMessage("NFC permission was not granted.");
    }
  };

  return (
    <div className={`job-card ${job.status === "Pending Acceptance" ? "is-pending" : ""}`}>
      <div className="job-top">
        <div>
          <span
            className={`severity ${severityClass(job.severity)}`}
          >
            {job.severity}
          </span>

          {job.priority === "Urgent" && (
            <span className="urgent-badge">
              URGENT
            </span>
          )}
        </div>

        <span className={`job-id incident-token ${severityClass(job.severity)}`}>
          {job.id}
        </span>
      </div>

      <h3>{job.title}</h3>

      <p className="job-address">
        📍 {job.address}
      </p>

      <div className="job-info">
        <span>⚡ {job.feeder}</span>
        <span>📏 {job.distance}</span>
        <span>👥 {job.customers}</span>
      </div>

      <div className="job-status-row">
        <span>Status</span>

        <strong>
          {job.status === "Pending Acceptance" ? "Awaiting your acceptance" : job.status}
        </strong>
      </div>

      {job.status === "Pending Acceptance" && (
        <div className="pending-assignee">
          Nearest ready crew · {job.assignedDistance}
        </div>
      )}

      {expanded && (
        <div className="job-details">
          <div>
            <span>Estimated arrival</span>
            <strong>{job.eta}</strong>
          </div>

          <div>
            <span>Customers affected</span>
            <strong>{job.customers}</strong>
          </div>

          <div>
            <span>Feeder</span>
            <strong>{job.feeder}</strong>
          </div>
        </div>
      )}

      {showSafety && (
        <div className="safety-card">
          <h3>Safety checklist</h3>
          {SAFETY_ITEMS.map((item, index) => (
            <label key={item} className="safety-row">
              <input type="checkbox" checked={Boolean(checked[index])} onChange={(event) => setChecked((current) => ({ ...current, [index]: event.target.checked }))} />
              {item}
            </label>
          ))}
          <button type="button" disabled={!SAFETY_ITEMS.every((_, index) => checked[index])} onClick={() => { setShowSafety(false); advance(); }}>
            Confirm &amp; start work
          </button>
        </div>
      )}

      <div className="photo-capture">
        <label className="photo-btn">+ Add photo<input type="file" accept="image/*" capture="environment" multiple hidden onChange={addPhotos} /></label>
        {photoMessage && <small>{photoMessage}</small>}
        <div className="photo-grid">{photos.map((photo, index) => <img key={`${photo.url}-${index}`} src={photo.url} alt="Job evidence" />)}</div>
      </div>

      <div className="asset-scan">
        <strong>Asset scan</strong>
        <div className="asset-controls">
          <input value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="Asset ID" />
          <button type="button" className="camera-qr-btn" onClick={openQrCamera}>Use camera</button>
          <label>Scan QR<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label>
          <button type="button" onClick={readNfc}>Read NFC</button>
        </div>

        {cameraOpen && (
          <div className="camera-qr-panel">
            <video ref={videoRef} className="camera-view" autoPlay playsInline muted />
            <div className="camera-actions">
              <button type="button" onClick={captureQrFromCamera}>Capture QR</button>
              <button type="button" className="ghost" onClick={stopCamera}>Close</button>
            </div>
          </div>
        )}

        {assetMessage && <small>{assetMessage}</small>}
        {assetId && <span className="asset-result">Attached asset: {assetId}</span>}
      </div>

      <div className="job-actions">
        <button
          className="secondary-btn"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide details" : "View details"}
        </button>

        <button
          type="button"
          className="secondary-btn navigation-btn"
          onClick={() => {
            onNavigate?.(job);
            navigateTo(job.address);
          }}
        >
          Turn-by-turn
        </button>

        {nextStatus[job.status] && (
          <button
            className="primary-btn"
            onClick={advance}
              disabled={updating}
          >
              {updating ? "Getting location..." : job.status === "Pending Acceptance" ? "Accept task" : `${nextStatus[job.status]} →`}
          </button>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   LEADER LAYOUT
========================================================= */

function LeaderLayout({ crew, jobs, omsSource, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [selectedJobId, setSelectedJobId] = useState(null);
  const selectedJob = jobs.find((job) => job.id === selectedJobId);

  return (
    <div className="leader-app">
      <LeaderHeader
        crew={crew}
        onLogout={onLogout}
      />

      <main className="leader-content">
        {tab === "dashboard" && (
          <LeaderDashboard jobs={jobs} omsSource={omsSource} />
        )}

        {tab === "jobs" && (
          selectedJob ? (
            <LeaderJobDetail
              job={selectedJob}
              onBack={() => setSelectedJobId(null)}
            />
          ) : (
            <LeaderJobs
              jobs={jobs}
              omsSource={omsSource}
              onSelectJob={setSelectedJobId}
            />
          )
        )}

        {tab === "team" && (
          <TeamOverview jobs={jobs} />
        )}

        {tab === "map" && (
          <MapView jobs={jobs} />
        )}

        {tab === "me" && (
          <Profile
            crew={crew}
            onLogout={onLogout}
          />
        )}
      </main>

      <BottomNavigation
        tab={tab}
        setTab={setTab}
        items={[
          ["dashboard", "Dashboard", "📊"],
          ["jobs", "Jobs", "📋"],
          ["team", "Team", "👥"],
          ["map", "Map", "🗺️"],
          ["me", "Me", "👤"],
        ]}
      />
    </div>
  );
}

/* =========================================================
   LEADER DASHBOARD
========================================================= */

function LeaderDashboard({ jobs, omsSource }) {
  const critical = jobs.filter(
    (j) => j.severity === "Critical"
  ).length;

  const urgent = jobs.filter(
    (j) => j.priority === "Urgent"
  ).length;

  const active = jobs.filter(
    (j) => j.status !== "Work Complete"
  ).length;

  const pending = jobs.filter(
    (j) => j.status === "Pending Acceptance"
  ).length;

  return (
    <>
      <PageHeader
        title="Operations Dashboard"
        subtitle={`Ganga Corridor · ${omsSource === "oms" ? "Live OMS priority jobs" : "Demo OMS priority jobs"}`}
      />

      <div className="dashboard-grid">
        <DashboardCard
          title="Active Outages"
          value={active}
          icon="⚡"
        />

        <DashboardCard
          title="Critical"
          value={critical}
          icon="🚨"
        />

        <DashboardCard
          title="Urgent Jobs"
          value={urgent}
          icon="🔥"
        />

        <DashboardCard
          title="Crews Online"
          value="4/5"
          icon="👷"
        />

        <DashboardCard
          title="Pending Acceptance"
          value={pending}
          icon="⏳"
        />
      </div>

      {pending > 0 && (
        <>
          <div className="section-title">Pending tasks</div>
          {jobs.filter((job) => job.status === "Pending Acceptance").map((job) => (
            <div className="pending-leader-card" key={job.id}>
              <div>
                <strong>{job.title}</strong>
                <span>{job.id} · {job.address}</span>
              </div>
              <small>Nearest ready crew<br />{job.assignedDistance}</small>
            </div>
          ))}
        </>
      )}

      <div className="section-title">
        Network status
      </div>

      <div className="network-card">
        <div className="network-header">
          <div>
            <span className="online-dot" />
            System Operational
          </div>

          <strong>98.4%</strong>
        </div>

        <div className="network-bar">
          <div />
        </div>

        <div className="network-footer">
          <span>Voltage stable</span>
          <span>SCADA connected</span>
          <span>Database synced</span>
        </div>
      </div>

      <div className="section-title">
        Critical incidents
      </div>

      {jobs.filter(
        (job) => job.severity === "Critical"
      ).map((job) => (
        <div className="incident-alert" key={job.id}>
          <div className="alert-icon">!</div>

          <div>
            <strong>{job.title}</strong>

            <span>{job.address}</span>

            <small>
              {job.customers} customers affected
            </small>
          </div>

          <span className="alert-status">
            {job.status}
          </span>
        </div>
      ))}
    </>
  );
}

/* =========================================================
   LEADER JOBS
========================================================= */

function LeaderJobs({ jobs, omsSource, onSelectJob }) {
  const [filter, setFilter] = useState("All");
  const pendingJobs = jobs.filter(
    (job) => job.status === "Pending Acceptance"
  );
  const filteredJobs = jobs.filter((job) => {
    if (filter === "Pending") return job.status === "Pending Acceptance";
    if (filter === "Urgent") return job.priority === "Urgent";
    if (filter === "Active") return job.status !== "Work Complete";
    if (filter === "Completed") return job.status === "Work Complete";
    return true;
  });

  return (
    <>
      <PageHeader
        title="All Jobs"
        subtitle={`${pendingJobs.length} pending acceptance · ${omsSource === "oms" ? "Live OMS assignment feed" : "Demo OMS assignment feed"}`}
      />

      <div className="leader-filter-row">
        {["All", "Pending", "Urgent", "Active", "Completed"].map((option) => (
          <button
            key={option}
            className={filter === option ? "filter-active" : ""}
            onClick={() => setFilter(option)}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="job-list">
        {filteredJobs.map((job) => (
          <div
            className="leader-job-card"
            key={job.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectJob(job.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectJob(job.id);
              }
            }}
          >
            <div>
              <span
                className={`severity ${severityClass(job.severity)}`}
              >
                {job.severity}
              </span>

              <h3>{job.title}</h3>

              <p>{job.address}</p>
            </div>

            <div className="leader-job-right">
              <strong className={job.status === "Pending Acceptance" ? "pending-status" : ""}>
                {job.status === "Pending Acceptance" ? "Pending acceptance" : job.status}
              </strong>

              <small>
                {job.id}
              </small>
            </div>

            {job.status === "Pending Acceptance" && (
              <div className="leader-pending-meta">
                OMS assigned nearest ready crew · {job.assignedDistance}
              </div>
            )}

          </div>
        ))}
      </div>

      {filteredJobs.length === 0 && (
        <div className="none">
          <div className="none-ico">✓</div>
          No {filter.toLowerCase()} jobs found
        </div>
      )}
    </>
  );
}

function LeaderJobDetail({ job, onBack }) {
  const isPending = job.status === "Pending Acceptance";

  return (
    <div className="leader-job-detail">
      <button className="detail-back-button" onClick={onBack}>
        <span>←</span> Back to all jobs
      </button>

      <div className="detail-heading">
        <div>
          <span className={`severity ${severityClass(job.severity)}`}>
            {job.severity}
          </span>
          {job.priority === "Urgent" && (
            <span className="urgent-badge">URGENT</span>
          )}
          <h1>{job.title}</h1>
          <p>{job.id} · {job.address}</p>
        </div>
        <strong className={isPending ? "pending-status" : "detail-status"}>
          {isPending ? "Awaiting acceptance" : job.status}
        </strong>
      </div>

      <div className="detail-meta-grid">
        <div><small>Feeder</small><strong>{job.feeder}</strong></div>
        <div><small>Customers affected</small><strong>{job.customers}</strong></div>
        <div><small>Distance</small><strong>{job.distance}</strong></div>
        <div><small>Estimated arrival</small><strong>{job.eta}</strong></div>
      </div>

      <div className="detail-section">
        <h2>OMS assignment</h2>
        <p>
          {job.assignedCrewId
            ? `Assigned crew: ${job.assignedCrewId}`
            : "Waiting for OMS crew assignment"}
        </p>
        {isPending && (
          <div className="detail-pending-note">
            Nearest ready crew selected by OMS · {job.assignedDistance}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h2>Incident location</h2>
        <p>{job.address}</p>
        <div className="detail-map-placeholder">📍 OMS location preview</div>
      </div>
    </div>
  );
}

/* =========================================================
   TEAM OVERVIEW
========================================================= */

function TeamOverview({ jobs }) {

  return (
    <>
      <PageHeader
        title="Team Overview"
        subtitle="Live status of field crews"
      />

      <div className="team-summary">
        <div>
          <strong>{CREWS.filter((item) => CREW_STATUSES[item.name] !== "Offline").length}</strong>
          <span>Online</span>
        </div>

        <div>
          <strong>{CREWS.filter((item) => CREW_STATUSES[item.name] === "On Site").length}</strong>
          <span>On Site</span>
        </div>

        <div>
          <strong>{CREWS.filter((item) => CREW_STATUSES[item.name] === "En Route").length}</strong>
          <span>En Route</span>
        </div>
      </div>

      <div className="section-title">
        Field units
      </div>

      <div className="team-list">
        {CREWS.map((crew) => (
          <div className="team-card" key={crew.id}>
            <div className="avatar">
              {crew.name.charAt(5)}
            </div>

            <div className="team-info">
              <strong>{crew.name}</strong>

              <span>
                {crew.lead}
              </span>

              <small>
                {crew.skills.join(" · ")}
              </small>
              {jobs.filter((job) => job.assignedCrewId === crew.id).map((job) => (
                <em className="team-assignment" key={job.id}>{job.id} · {job.title}</em>
              ))}
            </div>

            <div
              className={`team-status ${
                jobs.some((job) => job.assignedCrewId === crew.id)
                  ? "busy"
                  : CREW_STATUSES[crew.name] === "Offline"
                  ? "offline"
                  : CREW_STATUSES[crew.name] ===
                    "Available"
                  ? "available"
                  : "busy"
              }`}
            >
              <span />
              {jobs.some((job) => job.assignedCrewId === crew.id)
                ? "Assigned"
                : CREW_STATUSES[crew.name]}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* =========================================================
   MAP
========================================================= */

function MapView({ jobs, selectedJobId: initialSelectedJobId = null }) {
  const [selectedJobId, setSelectedJobId] = useState(initialSelectedJobId);
  useEffect(() => setSelectedJobId(initialSelectedJobId), [initialSelectedJobId]);
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const markerPositions = [
    { top: "21%", left: "20%" },
    { top: "43%", left: "72%" },
    { top: "64%", left: "39%" },
    { top: "76%", left: "68%" },
    { top: "30%", left: "48%" },
  ];
  const routeAllUrl = buildMultiStopUrl(jobs);

  return (
    <>
      <PageHeader
        title="Outage Map"
        subtitle="Assigned incidents across the corridor"
      />

      <div className="map-container">
        <div className="map-grid">
          <div className="map-road road-1" />
          <div className="map-road road-2" />
          <div className="map-road road-3" />

          <div className="map-river" />

          {jobs.map((job, index) => (
            <button
              key={job.id}
              className={`map-marker marker-${index} marker-${severityClass(job.severity)}`}
              title={job.title}
              style={markerPositions[index % markerPositions.length]}
              aria-label={`View ${job.title}`}
              aria-pressed={selectedJobId === job.id}
              onClick={() => setSelectedJobId(job.id)}
            >
              ⚡
            </button>
          ))}

          <div className="crew-marker">
            👷
          </div>
        </div>

        <div className="map-legend">
          <span>
            <i className="legend-dot crew" />
            Crew
          </span>

          <span>
            <i className="legend-dot critical" />
            Critical
          </span>

          <span>
            <i className="legend-dot normal" />
            Incident
          </span>
        </div>
      </div>

      {jobs.length > 1 && routeAllUrl && (
        <div className="map-route-panel">
          <div>
            <strong>Multi-job route</strong>
            <small>{jobs.length} stops in sequence</small>
          </div>
          <button type="button" className="primary-btn route-all-button" onClick={() => openMultiJobRoute(jobs)}>
            Route all jobs
          </button>
        </div>
      )}

      {selectedJob && (
        <div className="map-job-panel">
          <div>
            <strong>{selectedJob.title}</strong>
            <span>{selectedJob.id} · {selectedJob.address}</span>
            <small>{selectedJob.status} · {selectedJob.customers} customers affected</small>
          </div>
          <div className="map-job-actions">
            <button type="button" onClick={() => navigateTo(selectedJob.address)}>Turn-by-turn</button>
            <button type="button" onClick={() => setSelectedJobId(null)}>Close</button>
          </div>
        </div>
      )}

      <div className="map-note">
        Select an incident marker to view the outage location and assigned crew.
      </div>
    </>
  );
}

/* =========================================================
   PROFILE
========================================================= */

function Profile({ crew, onLogout }) {
  const [showSignOut, setShowSignOut] = useState(false);
  const [settings, setSettings] = useState({
    notifications: true,
    biometric: true,
    offline: true,
  });

  const toggleSetting = (setting) => {
    setSettings((current) => ({
      ...current,
      [setting]: !current[setting],
    }));
  };

  if (showSignOut) {
    return (
      <div className="signout-page">
        <div className="signout-icon">↗</div>
        <PageHeader
          title="Sign out"
          subtitle="End your current OMS field session"
        />

        <div className="signout-panel">
          <h2>Ready to sign out?</h2>
          <p>
            Your local session will close. You can sign in again with your OMS
            email and password.
          </p>
          <div className="signout-actions">
            <button
              className="signout-cancel"
              onClick={() => setShowSignOut(false)}
            >
              Cancel
            </button>
            <button className="signout-confirm" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="My Profile"
        subtitle="Account and session information"
      />

      <div className="profile-card">
        <div className="profile-avatar">
          {crew.name.charAt(5)}
        </div>

        <div>
          <h2>{crew.name}</h2>

          <p>{crew.lead}</p>

          <span>{crew.id}</span>
        </div>
      </div>

      <div className="profile-grid">
        <div>
          <small>Role</small>
          <strong>{crew.role}</strong>
        </div>

        <div>
          <small>Shift</small>
          <strong>{crew.shift}</strong>
        </div>

        <div>
          <small>Skills</small>
          <strong>
            {crew.skills.join(", ")}
          </strong>
        </div>

        <div>
          <small>Network</small>
          <strong className="green-text">
            Online
          </strong>
        </div>
      </div>

      <div className="settings-card">
        <h3>Settings</h3>

        <div className="setting-row">
          <span>Push notifications</span>
          <button
            className={`toggle ${settings.notifications ? "active" : ""}`}
            aria-label="Toggle push notifications"
            aria-pressed={settings.notifications}
            onClick={() => toggleSetting("notifications")}
          >
            <span />
          </button>
        </div>

        <div className="setting-row">
          <span>Biometric unlock</span>
          <button
            className={`toggle ${settings.biometric ? "active" : ""}`}
            aria-label="Toggle biometric unlock"
            aria-pressed={settings.biometric}
            onClick={() => toggleSetting("biometric")}
          >
            <span />
          </button>
        </div>

        <div className="setting-row">
          <span>Offline mode</span>
          <button
            className={`toggle ${settings.offline ? "active" : ""}`}
            aria-label="Toggle offline mode"
            aria-pressed={settings.offline}
            onClick={() => toggleSetting("offline")}
          >
            <span />
          </button>
        </div>
      </div>

      <button
        className="logout-button"
        onClick={() => setShowSignOut(true)}
      >
        Sign out
      </button>
    </>
  );
}

/* =========================================================
   HEADER
========================================================= */

function Header({ crew, title, online, onLogout }) {
  return (
    <header className="mobile-header">
      <div>
        <div className="header-brand">
          ⚡ OMS Crew
        </div>

        <small>
          {title}
        </small>
      </div>

      <div className="header-actions">
        <span className={`header-network ${online ? "online" : "offline"}`}>
          <i className="network-dot" />
          {online ? "Online" : "Offline"}
        </span>

        <button
          className="header-avatar"
          onClick={onLogout}
          title="Sign out"
        >
          {crew.name.charAt(5)}
        </button>
      </div>
    </header>
  );
}

/* =========================================================
   LEADER HEADER
========================================================= */

function LeaderHeader({ crew, onLogout }) {
  return (
    <header className="leader-header">
      <div>
        <div className="header-brand">
          ⚡ OMS Leader
        </div>

        <small>
          Ganga Corridor Operations
        </small>
      </div>

      <div className="leader-header-right">
        <div className="system-online">
          <span />
          System Online
        </div>

        <button
          className="header-avatar"
          onClick={onLogout}
        >
          {crew.name.charAt(5)}
        </button>
      </div>
    </header>
  );
}

/* =========================================================
   BOTTOM NAVIGATION
========================================================= */

function BottomNavigation({
  tab,
  setTab,
  items,
}) {
  return (
    <nav className="bottom-navigation">
      {items.map(([id, label, icon]) => (
        <button
          key={id}
          className={
            tab === id ? "nav-active" : ""
          }
          onClick={() => setTab(id)}
        >
          <span>{icon}</span>
          <small>{label}</small>
        </button>
      ))}
    </nav>
  );
}

/* =========================================================
   PAGE HEADER
========================================================= */

function PageHeader({ title, subtitle }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>

      <p>{subtitle}</p>
    </div>
  );
}

/* =========================================================
   SUMMARY CARD
========================================================= */

function SummaryCard({ label, value, active, onClick }) {
  return (
    <button
      type="button"
      className={`summary-card ${active ? "summary-card-active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Show ${label.toLowerCase()} jobs`}
    >
      <strong>{value}</strong>
      <span>{label}</span>
    </button>
  );
}

/* =========================================================
   DASHBOARD CARD
========================================================= */

function DashboardCard({
  title,
  value,
  icon,
}) {
  return (
    <div className="dashboard-card">
      <div className="dashboard-icon">
        {icon}
      </div>

      <div>
        <span>{title}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function CrewEmailLogin({ onSuccess }) {
  const [email, setEmail] = useState("crew01@oms.com");
  const [password, setPassword] = useState("demo");
  const [error, setError] = useState("");

  const submit = (event) => {
    event.preventDefault();
    if (email.trim().toLowerCase() !== "crew01@oms.com" || password !== "demo") {
      setError("Use the demo crew credentials shown below.");
      return;
    }
    onSuccess();
  };

  return (
    <div className="app-shell">
      <div className="login-screen">
        <div className="brand">
          <div className="brand-icon">⚡</div>
          <div><h1>OMS <span>Crew</span></h1><p>Field operations workspace</p></div>
        </div>
        <div className="login-card">
          <h2>Crew sign in</h2>
          <p className="muted">Sign in to view jobs assigned to your field crew.</p>
          <form className="email-login-form" onSubmit={submit}>
            <label htmlFor="crew-email">Email</label>
            <input id="crew-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
            <label htmlFor="crew-password">Password</label>
            <input id="crew-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            {error && <p className="login-error">{error}</p>}
            <button className="email-submit" type="submit">Sign in <span>→</span></button>
          </form>
          <div className="demo-accounts"><span>Demo crew account</span><button type="button" onClick={() => { setEmail("crew01@oms.com"); setPassword("demo"); setError(""); }}><strong>crew01@oms.com</strong><small>password: demo</small></button></div>
        </div>
        <div className="login-footer">Crew access only · Offline capable</div>
      </div>
    </div>
  );
}