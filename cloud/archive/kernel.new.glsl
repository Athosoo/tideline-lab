/* ===========================================================================
   CLOUD-KERNEL v2  ·  前端「灵活体积云」唯一真相来源
   ---------------------------------------------------------------------------
   由 _lab/tools/sync-kernel.mjs 注入到 lab 与 ship 的 CLOUD-KERNEL 标记区。
   不要直接编辑注入后的副本。

   理论骨架（参数化 / 可分级的近似映射）：
     密度   = 高度剖面(云型) × 天气覆盖(艺术输入) × 形状噪声 × 细节噪声
     光照   = 单次散射 + 4 阶指数和多重散射近似（贡献度 A / 遮蔽度 B 两个旋钮）
     积分   = 粗探针预步进（低分辨率探针 → 只在非空区加密采样）
              + 距离自适应步长 + 预算自适应 + 提前跳出
     介质   = Beer-Lambert 消光 + Henyey-Greenstein 双叶相位函数

   宿主负责：#version / precision / out 变量 / main()。
   本文件负责：全部 uniform 声明（宿主不得重复声明）。
   =========================================================================== */

uniform vec2  uRes;
uniform float uTime;
uniform float uJitter;
uniform vec3  uCamPos;
uniform mat3  uCamBasis;
uniform float uFovTan;
uniform float uAspect;

uniform sampler3D uNoise;
uniform sampler3D uWorley;
uniform float uNoiseLo,  uNoiseHi;
uniform float uWorleyLo, uWorleyHi;

uniform vec2  uSeedXZ;      // 噪声域偏移：把「哪朵云在你头顶」变成艺术参数
uniform float uCoverage;    // 0..1  天空被覆盖的比例（艺术输入）
uniform float uType;        // 0 层云 .. 1 积云 .. 2 积雨云
uniform float uDensityMul;  // 密度倍率
uniform float uDetail;      // 0..1 细节噪声振幅
uniform float uBase, uTop;  // 云底 / 云顶海拔（米）
uniform float uMaxDist;     // 最远追踪距离（米）
uniform float uWind;        // 漂移速度 m/s

uniform vec3  uSunDir;      // 指向太阳的单位向量
uniform vec3  uSunColor;    // 太阳辐亮度（含艺术增益，宿主负责量级）
uniform vec3  uSkyTop, uSkyHorizon, uHazeColor;
uniform float uSkyScale;    // 天空/环境光整体缩放（昼夜）

uniform float uAerial, uAerialK;   // 空气透视开关 / 密度 1/m
uniform float uMSContrib;          // 多重散射「贡献度」 A
uniform float uMSOccl;             // 多重散射「遮蔽度」 B
uniform float uPowder;             // 粉化（边缘透光）强度
uniform float uPhaseG, uPhaseMix;  // HG 双叶参数
uniform float uAmbScale;           // 环境光倍率

uniform int   uSteps, uLightSteps;
uniform float uStoreLdr;
uniform float uDebug;

const float PI      = 3.14159265359;
const float R_EARTH = 6371000.0;
const float EXT_PER_DENSITY = 0.0012;   // 归一化密度 1.0 对应的消光系数 (1/m)

/* ── 光照标定（这三条是按我们的 σe 量级实测标出来的，别照抄参考实现的数值）──
   SUN_GAIN : 参考实现的太阳辐亮度是物理量级（HDR 几十~几百）；我们的 uSunColor
              只有 11，多重散射归一后又只剩 ~0.1，实测云体比天空还暗。这里补艺术增益。
   SKY_AMB  : 天空色是「辐照度」，进云要转成辐亮度。参考用 1/4π≈0.08（它有色度 LUT），
              我们的 palette 不是物理量，实测 0.08 让暗面死黑、云和背景同色 → 用 0.30。
   POWDER_LEN: 参考的 exp(-σe·150) 是它自己的消光量级（σe≈0.01/m）。我们 σe≈0.0012/m，
              同一数值会把整片云乘掉 70%（实测 0.11）→ 长度尺度放大到 1000 m。        */
const float SUN_GAIN    = 4.0;
const float SKY_AMB     = 0.30;
const float POWDER_LEN  = 1000.0;
/* 密度底噪门限：低于它的密度一律当空气。腐蚀算子的连续尾巴会在平视时
   累积成满屏白絮（用户报的"云朵间隙模糊散落"）。0.10 = 吃掉最稀的 10%。 */
const float DENSITY_FLOOR = 0.10;

/* ── 去规整化：频段分离 + 两层域扭曲（2026-10-20）────────────────────────
   旧做法天气场和形状场都用 0.00030 采样同一张 64³ 平铺纹理：单一 3.3 km 周期，
   20 km 视距内精确复读约 6 次，俯视就是一张规则网格（证据：
   _lab/shots/look-base/top-dbg2.png 与 look-after/top-dbg2.png）。

   两条一起改：
   1) **频段分离**：天气 / 形状 / 两层扭曲分别用 30 / 37 / 19 / 23 ×1e-5。
      纹理本身是无缝平铺的（Perlin 生成时按整数周期 wrap，见宿主 buildNoise），
      所以任何频率都不会出新接缝；而四个互质整数频率的**联合周期 = 1e5 m = 100 km**
      （T 必须同时是 1e5/30、1e5/37、1e5/19、1e5/23 的整数倍，最小解 T=1e5）。
      20 km 视距只走到 1/5 个周期，不再整块复读。**不要**把某个频段改成
      非整数 ×1e-5（例如 30.5），那会让联合周期塌回几十公里以内，重复感回来。
   2) **两层域扭曲**：每层一个低频噪声标量，各自不同 offset、不同频率，
      合计把采样位置最多推开 ±1.2 km（约 0.5 个天气特征尺寸），Perlin 的
      轴向格子被揉成有机分布。扭曲场自己的频率（19/23）与天气（30）不同，
      于是「天气 ∘ 扭曲」的联合周期也是 100 km —— 只改频段不加扭曲，
      天气覆盖的空洞仍会按 3.3 km 的节奏排队；只加扭曲不改频段，
      扭曲场和天气同周期时复读也还在。两件事必须一起做。            */
const vec2  W_OFF   = vec2(0.137, 0.571);   // 天气场 offset
const vec2  S_OFF   = vec2(0.619, 0.233);   // 形状场 offset（与天气错开，避免同相）
const vec2  W1_OFF  = vec2(0.317, 0.811);   // 域扭曲第 1 层 offset
const vec2  W2_OFF  = vec2(0.743, 0.129);   // 域扭曲第 2 层 offset
const float W_SCALE  = 0.00030;             // 30e-5  天气场
const float S_SCALE  = 0.00037;             // 37e-5  形状场
const float W1_SCALE = 0.00019;             // 19e-5  扭曲层 1
const float W2_SCALE = 0.00023;             // 23e-5  扭曲层 2
const float WARP_AMP = 1200.0;              // 米：两层合计最大位移 ±1.2 km

/* 两层域扭曲：返回世界空间 XZ 位移（米）。两个标量各推一个轴。 */
vec2 domainWarp(vec3 q){
  float a = texture(uNoise, vec3(q.xz * W1_SCALE + W1_OFF, 0.211)).r;
  float b = texture(uNoise, vec3(q.xz * W2_SCALE + W2_OFF, 0.733)).r;
  return (vec2(a, b) - 0.5) * WARP_AMP;
}

/* 调试输出（lab 用，ship 忽略） */
float gDbgShape, gDbgCover, gDbgBody, gDbgSteps, gDbgSkips;

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 raySphere(vec3 ro, vec3 rd, float r){
  vec3 oc = ro - vec3(0.0, -R_EARTH, 0.0);
  float b = dot(oc, rd);
  float c = dot(oc, oc) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

/* 把噪声重标定到 0..1：数组的 p5/p95 由 CPU 侧实测传入，阈值因此可以跨噪声设置复现 */
float nrm(float v, float lo, float hi){
  return clamp((v - lo) / max(hi - lo, 1e-5), 0.0, 1.0);
}

/* ── 高度剖面：同一条公式派生三种云型 ──────────────────────────────────────
   层云 = 薄的均匀板；积云 = 圆顶；积雨云 = 塔状 + 顶部砧状展开。            */
float heightProfile(float h, float type){
  float bot   = smoothstep(0.0, 0.055, h);
  float slab  = 1.0 - smoothstep(0.45, 0.92, h);
  float dome  = 1.0 - smoothstep(0.26, 0.78, h);
  float tower = 1.0 - smoothstep(0.50, 0.90, h);
  float lo = mix(slab, dome, clamp(type, 0.0, 1.0));
  float hi = mix(dome, tower, clamp(type - 1.0, 0.0, 1.0));
  float p  = mix(lo, hi, step(1.0, type));
  float anvil = smoothstep(0.62, 0.97, h) * (1.0 - smoothstep(0.975, 1.0, h));
  p = max(p, anvil * clamp(type - 1.0, 0.0, 1.0));
  return bot * clamp(p, 0.0, 1.0);
}

/* 线性重映射（参考实现的 remapClamped）。整条密度链只用这个，不用 smoothstep 阈值。 */
float remap01(float v, float lo, float hi){
  return clamp((v - lo) / max(hi - lo, 1e-5), 0.0, 1.0);
}

float hgPhase(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
/* 双叶 HG 的凸组合：权重和为 1，所以整个球面的积分仍然守恒 */
float phaseFn(float mu){
  float g = uPhaseG;
  float m = clamp(uPhaseMix * 0.5 + 0.5, 0.0, 1.0);
  return mix(hgPhase(mu, g), hgPhase(mu, -g * 0.45), m);
}

/* ── 密度 v3 ───────────────────────────────────────────────────────────────
   把旧的「5 路噪声加权和 + smoothstep(0.40,0.56) 绝对阈值」换成
   「覆盖度软斜坡 + 腐蚀算子」。为什么这决定了有没有体积感
   （见 _wip/NOTES-takram-shader-distill.md §2.3）：

     1. 腐蚀而不是乘法：density = remap(density, (1-shape)*amount, 1)
        —— 云的**表面**变成 shape 噪声的等值面；shape 高则阈值低、该处保留，
        shape 低则被"啃掉"。乘法只改体内部亮度，把表面温度写死成某个常数，
        于是任何视角下都是同一层壳 → 平板感。
     2. 没有绝对阈值：全链只有线性斜坡，云内密度连续 0→1。
        二值化的色块没有内部梯度，光打上去只剩一个平色。
     3. 竖向半圆偏置 hs = 1-x²：云在底/顶收窄，这是积云轮廓的来源。
     4. 双尺度：shape 3.3 km（大菜花）+ Worley 167 m（小绒球）两级腐蚀。

   高度剖面 prof 放最前面：为 0 的空域直接 return，省掉 4 次 3D 采样。      */
float cloudDensity(vec3 p, out float h01){
  h01 = (p.y - uBase) / max(uTop - uBase, 1.0);
  float hf = clamp(h01, 0.0, 1.0);
  float prof = heightProfile(hf, uType);
  if (prof <= 5e-4) return 0.0;

  vec3 q = p + vec3(uSeedXZ.x, 0.0, uSeedXZ.y) - vec3(uWind, 0.0, uWind * 0.35) * uTime;

  /* ── 1. 天气 → 覆盖度：宽 0.6 的软斜坡，factor 随高度做半圆偏置 ──
     关键：先把天气往「满覆盖」拉 60%（参考实现的 mix(localWeather,1,covFilterWidth)），
     再在 [factor, factor+0.6] 上做线性斜坡。少了这一步，coverage=0.44 实际只覆盖
     约 10% 天空，云会退化成地平线上的几个小点（实测：p1-v3）。

     尺度：天气场原来是 16 km 周期 —— 从地面平视时，一朵云就占满整个视野，
     数不出独立云团，看上去必然是一面墙。改成 3.3 km 周期（主导特征约 1~2 km），
     20 km 外一眼能看到 5~10 朵分开的积云，中间露出天空。                     */
  /* 域扭曲后的采样位置：天气 / 形状用不同的频率与 offset（周期 100 km，见文件顶部） */
  vec2 wq = domainWarp(q);
  vec3 qw = q + vec3(wq.x, 0.0, wq.y);

  float weather = nrm(texture(uNoise, vec3(qw.xz * W_SCALE + W_OFF, 0.37)).r, uNoiseLo, uNoiseHi);
  float cov  = clamp(uCoverage, 0.0, 1.0);
  float xh   = clamp(pow(hf, 0.35) * 2.0 - 1.0, -1.0, 1.0);
  float hs   = 1.0 - xh * xh;
  float factor = 1.0 - cov * hs;
  float occ  = remap01(mix(weather, 1.0, 0.60), factor, factor + 0.60);
  if (occ <= 5e-4) return 0.0;

  /* ── 2. 形状腐蚀：37e-5 频率（FBM 4 octave，最细约 110 m）── */
  float shape = nrm(texture(uNoise, vec3(qw.xz * S_SCALE + S_OFF, q.y * S_SCALE)).r, uNoiseLo, uNoiseHi);
  float amt   = mix(0.42, 0.80, clamp(uDetail, 0.0, 1.0));
  float d     = remap01(occ, (1.0 - shape) * amt, 1.0);

  /* ── 3. 细节腐蚀：Worley 胞约 167 m。顶部 = 圆润蓬松，底部 = 缕状撕边 ── */
  float det = nrm(texture(uWorley, q * 0.00120).r, uWorleyLo, uWorleyHi);
  float mod = mix(pow(det, 6.0), 1.0 - det, smoothstep(0.20, 0.40, hf));
  d = remap01(d * 2.0, mod * 0.5, 1.0);

  /* ── 4. 高度剖面 + 上密下疏 ── */
  d *= prof;
  d *= 0.25 + 0.75 * hf;

  /* ── 5. 密度底噪门限（DENSITY_FLOOR）──────────────────────────────────────
     腐蚀算子是连续的，所以凡是「刚过阈值」的地方都会留下 1%~8% 的密度尾巴。
     平视时这些尾巴沿视线累积成一整片发白的薄雾 —— 用户报的
     「云朵间隙有模糊散落、很丑」就是它（实测：覆盖率 0.21 时整片天空都是白絮）。
     低于门限一律当空气：云有干净的轮廓，云间隙是真的天空。               */
  d = remap01(d, DENSITY_FLOOR, 1.0);

  gDbgShape = shape; gDbgCover = occ; gDbgBody = d;
  return d * uDensityMul;
}

/* 只算密度的光照版：跳过覆盖度以外的调试量 */
float densityLite(vec3 p){ float h; return cloudDensity(p, h); }

/* ── 多重散射：Kulla-Conty 指数和，8 阶 ────────────────────────────────────
   每一阶同时衰减三样东西，比例都是 0.5^i：
     beer  = exp(-tau * 0.5^i)      ← 散射一次后剩余光程更短
     能量  × 0.5^i
     相位各向异性 g × 0.5^i         ← 越往高阶越接近各向同性
   第 0 阶就是纯单次散射；tau=0 时归一化回平均相位，不凭空造能量。
   旧的固定 4 阶 + 两个独立旋钮做不到「相位也一起塌缩」，背光面因此发灰。   */
float multiScatter(float tau, float mu, out float ambOcc){
  float g = clamp(uPhaseG, 0.0, 0.95);
  float m = clamp(uPhaseMix * 0.5 + 0.5, 0.0, 1.0);
  float sum = 0.0, norm = 0.0, w = 1.0, e = 1.0, gs = g;
  for (int o = 0; o < 8; o++){
    float ph = mix(hgPhase(mu, gs), hgPhase(mu, -gs * 0.45), m);
    sum  += w * exp(-e * tau) * ph;
    norm += w;
    w *= 0.5; e *= 0.5; gs *= 0.5;
  }
  /* 云内部的环境光被自身遮蔽：光学厚度越大，天光进得越少 → 顶亮底暗 */
  ambOcc = exp(-tau * 0.30);
  return sum / max(norm, 1e-4);
}

/* 沿太阳方向积分光学厚度（Beer-Lambert）。空域提前跳出。 */
float lightTau(vec3 p, float sigmaE, int n){
  float ls = max((uTop - uBase) / float(n), 40.0);
  float tau = 0.0;
  for (int j = 0; j < 16; j++){
    if (j >= n) break;
    vec3 lp = p + uSunDir * (float(j) + 0.5) * ls;
    if (lp.y < uBase - 300.0) break;
    tau += densityLite(lp) * ls * sigmaE;
  }
  return tau;
}

/* ── 主追踪 ────────────────────────────────────────────────────────────────
   返回 vec4(预乘内散射 rgb, 透射率 a)。

   采样 v3 —— 透视几何步长：
     dt 从 dt0 起按 R 增长；dt0 由「几何级数求和恰好铺满 [t0,t1]」反解，
     并夹到 ≥45 m。于是同样 n 个样本覆盖整条射线，近处 45~100 m / 远处数百米，
     而不是旧方案「990 m 探针格 + 格内 3~5 刀」的常数密度切片。

   抖动：每帧每像素一个偏移，作用于**首步**（整条射线一起滑）。
     步边界逐帧稳定 → 时间累积不会糊；累积把首步的阶梯收敛掉。
   ------------------------------------------------------------------------ */
vec4 marchClouds(vec3 ro, vec3 rd, out float outDist){
  outDist = 0.0;
  float trans = 1.0;
  vec3 acc = vec3(0.0);
  gDbgSteps = 0.0; gDbgSkips = 0.0;

  /* 只有「相机在云底之下 + 向下看」才必然无云；相机在云层之上时向下看应该看得见云 */
  if (rd.y <= 0.0 && ro.y < uBase) return vec4(acc, trans);

  vec2 outer = raySphere(ro, rd, R_EARTH + uTop);
  if (outer.y < 0.0) return vec4(acc, trans);
  float t0 = max(outer.x, 0.0);
  float t1 = min(outer.y, t0 + uMaxDist);

  /* 云区 = 在云顶球之内、且在云底球之外。相机在云底之下时射线「先出云底球」，
     相机在云层之上时射线「先进云底球」——两种情形切法相反。 */
  float rIn = R_EARTH + uBase;
  float dc  = length(ro - vec3(0.0, -R_EARTH, 0.0));
  vec2 inner = raySphere(ro, rd, rIn);
  if (dc < rIn) {
    if (inner.y > t0) t0 = max(t0, inner.y);
  } else if (inner.x > 0.0) {
    t1 = min(t1, inner.x);
  }
  if (t1 <= t0) return vec4(acc, trans);

  float span   = t1 - t0;
  float shell  = max(uTop - uBase, 1.0);
  float sigmaE = EXT_PER_DENSITY * uDensityMul;
  float mu     = dot(rd, uSunDir);
  vec3  haze   = uHazeColor * (0.72 + 0.28 * clamp(uSunDir.y * 3.0, 0.0, 1.0));

  int n = clamp(uSteps, 8, 192);
  const float R = 1.02;
  float dt = span * (R - 1.0) / max(pow(R, float(n)) - 1.0, 1e-4);
  dt = clamp(dt, 45.0, 400.0);

  /* 每帧/每像素的射线抖动：整条射线在第一个步长内滑动（只抖首步） */
  float jit = hash12(gl_FragCoord.xy + vec2(uJitter * 71.7, uJitter * 131.3));
  float t   = t0 + jit * dt;

  if (uDebug > 4.5){
    return vec4(heightProfile((ro.y + rd.y * t - uBase) / shell, uType),
                hash12(gl_FragCoord.xy), 0.0, 1.0);
  }

  float wsum = 0.0, dSum = 0.0, maxD = 0.0;

  for (int i = 0; i < 192; i++){
    if (i >= n || t >= t1 || trans < 0.008) break;

    vec3  p = ro + rd * t;
    float h01;
    float d = cloudDensity(p, h01);
    gDbgSteps += 1.0;
    if (d <= 0.002) gDbgSkips += 1.0;
    dSum += d; maxD = max(maxD, d);

    if (d > 0.002){
      float sigma = d * sigmaE;
      float a = 1.0 - exp(-sigma * dt);

      float tau = lightTau(p, sigmaE, uLightSteps);
      float ambOcc;
      float ms = multiScatter(tau, mu, ambOcc);

      /* 粉化：稀薄边缘压暗（深度线索）。注意方向与旧版相反 —— 旧版让边缘发亮，
         结果整个云像在发光，这是"发白发灰"的原因之一。 */
      float powder = 1.0 - 0.8 * exp(-sigma * POWDER_LEN);

      if (uDebug > 7.5) {
        /* 光照诊断：R=多重散射量, G=太阳方向光学厚度(×0.1), B=powder */
        return vec4(clamp(ms, 0.0, 1.0), clamp(tau * 0.1, 0.0, 1.0), clamp(powder, 0.0, 1.0), 1.0);
      }

      vec3 sun = uSunColor * ms * SUN_GAIN;
      /* 天空是「辐照度」，太阳是「辐亮度」——量级差一个 1/4π。
         旧版直接把天色当环境光用，环境光于是比太阳还亮 → 云和天空同色、发白发灰。 */
      vec3 amb = mix(uSkyHorizon, uSkyTop, h01)
               * (0.35 + 0.65 * ambOcc) * uSkyScale * uAmbScale * SKY_AMB;
      vec3 col = (sun + amb) * powder;

      if (uAerial > 0.5){
        float aer = 1.0 - exp(-t * uAerialK);
        col = mix(col, haze, clamp(aer, 0.0, 0.96));
      }

      acc   += col * a * trans;
      trans *= (1.0 - a);
      outDist += t * a;
      wsum  += a;
    }

    t += dt;
    dt = min(dt * R, 1200.0);
  }

  if (wsum > 0.0) outDist /= wsum; else outDist = t0 + (t1 - t0) * 0.4;

  if (uDebug > 5.5) return vec4(vec3(gDbgSteps / float(max(uSteps, 1))), 1.0);
  if (uDebug > 2.5) return vec4(clamp(dSum * 2.0, 0.0, 1.0), maxD, clamp(1.0 - trans, 0.0, 1.0), 1.0);
  if (uDebug > 0.5) return vec4(gDbgShape, gDbgCover, gDbgBody, 1.0);
  return vec4(acc, trans);
}

/* 天空：与云共用同一套 palette，云的霾色才有地方对齐 */
vec3 skyColor(vec3 rd){
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyTop, pow(y, 0.48)) * uSkyScale;
  float s = max(dot(rd, uSunDir), 0.0);
  c += uSunColor * pow(s, 10.0) * 0.020;
  c += uSunColor * smoothstep(0.99955, 0.99985, s) * 2.4;
  return c;
}
