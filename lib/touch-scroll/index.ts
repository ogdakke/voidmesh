// Copyright 2023 ktiays
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Modifications: ported to TypeScript, adapted for voidmesh
// original: https://github.com/ktiays/fluid-scroll

export { VelocityTracker } from "./velocity-tracker.ts";
export {
  Scroller,
  DecelerationRate,
  type ScrollerValue,
  type DecelerationRateValue,
} from "./scroller.ts";
export { SpringBack, type SpringBackValue } from "./spring-back.ts";
export { DampedSpring2D } from "./damped-spring.ts";
