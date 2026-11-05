// Усе, що передається в композицію, має серіалізуватися в JSON.

export type WatercolorCharacter =
  | "bloom" // розтікання від центру
  | "corner" // одна пляма з краю
  | "blots" // кілька плям, що зливаються
  | "wash" // змив згори вниз із патьоками
  | "wet"; // намокання паперу, зерниста текстура

export type WatercolorOptions = {
  character: WatercolorCharacter;
  seed: string;
  // Ширина м'якого краю в одиницях "часу відкриття" (0..1). Менше означає чіткіший край.
  soft: number;
  // Амплітуда живого руху краю, поки пляма росте (прив'язана до прогресу, тож при сповільненні теж сповільнюється).
  drift: number;
  // Амплітуда дрібного "дихання" краю, прив'язаного до реального часу (секунд), а не до прогресу.
  // Потрібне в довгих переходах, щоб край не завмирав. 0 або відсутнє означає без дихання.
  breath?: number;
  // Облямівка пігменту. null означає просто м'який край.
  edge: null | {
    // Скільки пігменту видно (0..1): наскільки край темнішає власним кольором кадру.
    strength: number;
    // Ширина смуги облямівки в тих самих одиницях, що й soft.
    width: number;
    // Додатковий колір пігменту (множення), напр. "#8a6a4a"; null без підфарбовування.
    tint: string | null;
    tintStrength: number;
  };
};

export type TransitionDescriptor =
  | { kind: "builtin"; name: "fade" | "linearBlur" | "zoomInOut" | "crosswarp" | "dissolve" | "dreamyZoom" | "ripple" | "blurSlide" | "none"; options?: Record<string, unknown> }
  | { kind: "watercolor"; options: WatercolorOptions };

export type ProbeProps = {
  // Шляхи відносно public/ (staticFile).
  frames: string[];
  fps: number;
  // Скільки кадрів кожен кадр видно без переходу.
  holdFrames: number;
  transitionFrames: number;
  zoomFrom: number;
  zoomTo: number;
  transition: TransitionDescriptor;
};
