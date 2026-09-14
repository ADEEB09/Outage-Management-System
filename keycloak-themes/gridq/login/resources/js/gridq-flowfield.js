document.addEventListener("DOMContentLoaded", function () {
  var fadeEl = document.createElement("div");
  fadeEl.id = "gridq-page-fade";
  document.body.appendChild(fadeEl);
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { fadeEl.classList.add("gridq-in"); });
  });

  var canvas = document.createElement("canvas");
  canvas.id = "gridq-canvas";
  document.body.insertBefore(canvas, document.body.firstChild);
  var vignette = document.createElement("div");
  vignette.id = "gridq-vignette";
  document.body.insertBefore(vignette, canvas.nextSibling);
  var fadeTop = document.createElement("div");
  fadeTop.id = "gridq-fade-top";
  document.body.insertBefore(fadeTop, vignette.nextSibling);
  var fadeBottom = document.createElement("div");
  fadeBottom.id = "gridq-fade-bottom";
  document.body.insertBefore(fadeBottom, fadeTop.nextSibling);

  var ctx = canvas.getContext("2d");
  var dpr = window.devicePixelRatio || 1;
  var W, H, time = 0;
  var particles = [];
  var COUNT = 1200;
  var HUE_START = 120, HUE_RANGE = 200;

  function spawn() {
    var maxLife = 200 + Math.floor(Math.random() * 300);
    return {
      x: Math.random() * W, y: Math.random() * H,
      speed: 1.1 + Math.random() * 1.8,
      hue: HUE_START + Math.random() * HUE_RANGE,
      life: Math.floor(Math.random() * maxLife),
      maxLife: maxLife,
    };
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "rgb(5,5,8)";
    ctx.fillRect(0, 0, W, H);
    particles = [];
    for (var i = 0; i < COUNT; i++) particles.push(spawn());
  }
  resize();
  window.addEventListener("resize", resize);

  function fieldAngle(x, y, t) {
    var s = 0.0025;
    return Math.sin(x * s + t * 0.0007) * Math.PI +
           Math.cos(y * s + t * 0.0005) * Math.PI +
           Math.sin((x + y) * s * 0.6 + t * 0.0009) * Math.PI * 0.6 +
           Math.cos((x - y) * s * 0.4 + t * 0.0006) * Math.PI * 0.4;
  }

  function render() {
    time++;
    ctx.fillStyle = "rgba(5,5,8,0.06)";
    ctx.fillRect(0, 0, W, H);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var angle = fieldAngle(p.x, p.y, time);
      p.x += Math.cos(angle) * p.speed;
      p.y += Math.sin(angle) * p.speed;
      p.life++;

      if (p.life > p.maxLife) {
        p.x = Math.random() * W; p.y = Math.random() * H;
        p.life = 0; p.hue = HUE_START + Math.random() * HUE_RANGE;
        continue;
      }
      if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
      if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;

      var progress = p.life / p.maxLife;
      var fadeIn = Math.min(progress * 8, 1);
      var fadeOut = Math.min((1 - progress) * 6, 1);
      var alpha = fadeIn * fadeOut * 0.9;
      var hueMod = (p.hue + (angle / (Math.PI * 2)) * 70 + 360) % 360;

      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + hueMod + ",90%,62%," + alpha + ")";
      ctx.fill();
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  var form = document.getElementById("kc-form-login");
  var card = document.querySelector(".pf-v5-c-login__main-body");
  if (form && card) {
    var submitted = false;
    form.addEventListener("submit", function (e) {
      if (submitted) return;
      e.preventDefault();
      card.classList.add("gridq-submitting");
      fadeEl.classList.remove("gridq-in");
      fadeEl.classList.add("gridq-out");
      submitted = true;
      setTimeout(function () { form.submit(); }, 420);
    });
  }
});