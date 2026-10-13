import * as React from "react";
export function useIsMobile() {
  const [mobile, setMobile] = React.useState<boolean>();
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return !!mobile;
}
