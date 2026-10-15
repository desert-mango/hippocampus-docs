## What it is

A replication and extension of Cai, Chang, and Girdhar's published *Learning to Swim*
reinforcement-learning pipeline for thruster-driven AUV control. The original research and
released `warplab/isaac-auv-env` implementation define the pipeline; this project tests its
reproducibility and vehicle-specific behavior rather than claiming that upstream work.

## What Kyle built and tested

- Reproduced the CUREE simulation pipeline through a policy that passed the project's two
  registered success bars.
- Derived vehicle parameters, thruster-allocation checks, fidelity audits, campaign tooling,
  and offline evaluation for HippoCampus and BlueROV2 Heavy simulation arms.
- Ran nine stock four-thruster HippoCampus campaigns on a reduced position-and-pointing task.
  Pointing often passed, while position remained the binding failure across all campaigns.

## Where it stands

The simulation replication and analysis are complete enough to expose both positive and
negative results. The work has not established transfer to either physical vehicle, and it
does not present simulated control performance as a hardware result.
