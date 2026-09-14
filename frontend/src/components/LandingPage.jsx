import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import FlowField from './kokonutui/flow-field.jsx';

const ease = [0.22, 0.61, 0.36, 1];
const sf = "-apple-system, BlinkMacSystemFont, \"SF Pro Display\", system-ui, sans-serif";
const sfText = "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", system-ui, sans-serif";

export default function LandingPage({ onEnter, username }) {
  const [fading, setFading] = useState(true);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setFading(false), 20);
    return () => clearTimeout(t);
  }, []);

  const handleEnter = () => {
    setExiting(true);
    setTimeout(onEnter, 420);
  };

  return (
    <FlowField theme="aurora" density="medium">
      <div style={{
        position: 'fixed', inset: 0, zIndex: 999, background: 'rgb(5,5,8)',
        opacity: (fading || exiting) ? 1 : 0,
        pointerEvents: (fading || exiting) ? 'all' : 'none',
        transition: 'opacity 0.4s ease',
      }} />

      <div style={{ position: 'relative', zIndex: 10, textAlign: 'center', padding: '0 24px', maxWidth: 620 }}>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: ease }}
          style={{ marginBottom: 22 }}
        >
          <span style={{
            fontFamily: sf,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            fontSize: 12,
            fontWeight: 600,
            color: "rgba(255,255,255,0.55)",
          }}>
            GridQ
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.15, ease: ease }}
          style={{
            fontFamily: sf,
            fontSize: "clamp(34px, 5vw, 52px)",
            fontWeight: 600,
            color: "#fff",
            letterSpacing: "-0.03em",
            lineHeight: 1.08,
            margin: "0 0 16px",
          }}
        >
          Outage Management,
          <br />
          <span style={{
            background: "linear-gradient(90deg, #fff 0%, rgba(255,255,255,0.55) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}>
            reimagined.
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.3, ease: ease }}
          style={{
            fontFamily: sfText,
            color: "rgba(255,255,255,0.56)",
            fontSize: 17,
            lineHeight: 1.55,
            margin: "0 auto 40px",
            maxWidth: 460,
            fontWeight: 400,
          }}
        >
        </motion.p>

        <motion.button
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.45, ease: ease }}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleEnter}
          style={{
            fontFamily: sfText,
            background: "rgba(255,255,255,0.92)",
            color: "#0a0a0a",
            border: "none",
            borderRadius: 980,
            padding: "14px 32px",
            fontSize: 16,
            fontWeight: 590,
            cursor: "pointer",
            letterSpacing: "-0.01em",
            boxShadow: "0 1px 2px rgba(0,0,0,0.15), 0 8px 30px rgba(255,255,255,0.08)",
            backdropFilter: "blur(20px)",
          }}
        >
          Enter Control Room
        </motion.button>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.7, ease: ease }}
          style={{
            marginTop: 64,
            paddingTop: 20,
            borderTop: "1px solid rgba(255,255,255,0.09)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
            fontSize: 12.5,
            color: "rgba(255,255,255,0.32)",
            letterSpacing: "0.01em",
          }}
        >
          <span>Akash Mall</span>
          <span style={{ width: 3, height: 3, borderRadius: 99, background: "rgba(255,255,255,0.25)" }} />
          <span>Aishanya Singh</span>
        </motion.div>

      </div>
    </FlowField>
  );
}