# UART Configuration


<div class="adm adm-attention"><p class="adm-title">Attention</p>

By default UART0 is used as a login terminal. Do not change this, unless there is a compelling reason to do so.



</div>

We have made the decision to use UART5 for the telemetry communication with the FCU. UART4 is connected to the debug port of the FCU.


## Enable UARTs


Edit the config file


```sh
sudo vim /boot/firmware/config.txt
```

and append the `dtoverlay=` lines for the required UARTs.


```sh
dtoverlay=uart2
dtoverlay=uart3
dtoverlay=uart4
dtoverlay=uart5
```

## UART-KERNELS-Pin Mapping


The UART functions in the following table depend on whether Raspberry Pi is used in a UUV or for the gantry controlling computer.


==== ======================= ===================== UART KERNELS                 Tx/Rx GPIOs ==== ======================= ===================== 0                            `GPIO14/GPIO15` 1 2    `fe201400.serial` `GPIO0/GPIO1` 3    `fe201600.serial` `GPIO4/GPIO5` 4    `fe201800.serial` `GPIO8/GPIO9` 5    `fe201a00.serial` `GPIO12/GPIO13` ==== ======================= =====================


## Pinout


<div class="tabs">

<div class="tab" data-label="UUV">

![pi pinout uuv](https://res.cloudinary.com/dr76gues0/image/upload/v1788428836/hippocampus-docs/setup/pi_pinout_uuv.svg)


</div>

<div class="tab" data-label="BlueROV (main)">

![pi pinout bluerov](https://res.cloudinary.com/dr76gues0/image/upload/v1788428906/hippocampus-docs/setup/pi_pinout_bluerov.svg)


</div>

<div class="tab" data-label="Gantry">

![pi pinout gantry](https://res.cloudinary.com/dr76gues0/image/upload/v1788428911/hippocampus-docs/setup/pi_pinout_gantry.svg)


</div>


</div>

## UART Rule


Create the file `/etc/udev/rules.d/50-serial.rules` with the following content:


<div class="tabs">

<div class="tab" data-label="UUV">

```sh
KERNEL=="ttyAMA[0-9]*", GROUP="dialout", ENV{SERIAL_MARKER}="fcu_serial"

# uart4
ENV{SERIAL_MARKER}=="fcu_serial",  SUBSYSTEM=="tty", KERNELS=="fe201800.serial", SYMLINK+="fcu_debug"
# uart5
ENV{SERIAL_MARKER}=="fcu_serial",  SUBSYSTEM=="tty", KERNELS=="fe201a00.serial", SYMLINK+="fcu_data"
```

</div>

<div class="tab" data-label="BlueROV (main)">

```sh
KERNEL=="ttyAMA[0-9]*", GROUP="dialout", ENV{SERIAL_MARKER}="serial_marker"

# uart2
ENV{SERIAL_MARKER}=="serial_marker",  SUBSYSTEM=="tty", KERNELS=="fe201400.serial", SYMLINK+="teensy_data"
# uart4
ENV{SERIAL_MARKER}=="serial_marker",  SUBSYSTEM=="tty", KERNELS=="fe201800.serial", SYMLINK+="fcu_debug"
# uart5
ENV{SERIAL_MARKER}=="serial_marker",  SUBSYSTEM=="tty", KERNELS=="fe201a00.serial", SYMLINK+="fcu_data"
```

</div>

<div class="tab" data-label="Gantry">

```sh
KERNEL=="ttyAMA[0-9]*", GROUP="dialout", ENV{SERIAL_MARKER}="motor_serial"

# uart2
ENV{SERIAL_MARKER}=="motor_serial",  SUBSYSTEM=="tty", KERNELS=="fe201400.serial", SYMLINK+="motor_x"
# uart4
ENV{SERIAL_MARKER}=="motor_serial",  SUBSYSTEM=="tty", KERNELS=="fe201800.serial", SYMLINK+="motor_y"
# uart5
ENV{SERIAL_MARKER}=="motor_serial",  SUBSYSTEM=="tty", KERNELS=="fe201a00.serial", SYMLINK+="motor_z"
```

</div>


</div>

You can apply these changes by


```console
$ sudo udevadm control --reload-rules && sudo udevadm trigger
```

To check, that the rule is applied correctly, you can execute


<div class="tabs">

<div class="tab" data-label="UUV">

```sh
ls /dev/fcu* -l
```

</div>

<div class="tab" data-label="Gantry">

```sh
ls /dev/motor* -l
```

</div>


</div>

The output should show symbolic links for the serial devices:


<div class="tabs">

<div class="tab" data-label="UUV">

```sh
lrwxrwxrwx 1 root root 7 Dec 11 14:57 /dev/fcu_debug -> ttyAMA1               
lrwxrwxrwx 1 root root 7 Dec 11 14:57 /dev/fcu_data -> ttyAMA2 
```

</div>

<div class="tab" data-label="Gantry">

```sh
lrwxrwxrwx 1 root root 7 Aug  7 01:00 /dev/motor_x -> ttyAMA2
lrwxrwxrwx 1 root root 7 Aug  7 01:00 /dev/motor_y -> ttyAMA3
lrwxrwxrwx 1 root root 7 Aug  7 01:00 /dev/motor_z -> ttyAMA4
```

</div>


</div>

<div class="adm adm-note"><p class="adm-title">Note</p>

The `ttyAMA` numbers might differ, depending on the UARTs you have activated.



</div>

## Identify KERNELS


To identify the KERNELS paramter of a certain `ttyAMA` device, execute the following command.


```console
$ udevadm info --name=/dev/ttyAMA1 --attribute-walk
```

```console
looking at device '/devices/platform/soc/fe201800.serial/tty/ttyAMA1':
KERNEL=="ttyAMA1"
SUBSYSTEM=="tty"
DRIVER==""

looking at parent device '/devices/ platform/soc/fe201800.serial':
KERNELS=="fe201800.serial"
SUBSYSTEMS=="amba"
DRIVERS=="uart-pl011"
ATTRS{driver_override}=="(null)"
ATTRS{id}=="00241011"
ATTRS{irq0}=="14"

looking at parent device '/devices/ platform/soc':
KERNELS=="soc"
SUBSYSTEMS=="platform"
DRIVERS==""
ATTRS{driver_override}=="(null)"

looking at parent device '/devices/ platform':
KERNELS=="platform"
SUBSYSTEMS==""
DRIVERS==""
```

<div class="adm adm-attention"><p class="adm-title">Attention</p>

The `ttyAMAx` number is not specific for the UART device and depends on how many UARTs are activated.



</div>


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/raspberry_pi_setup/uart_configuration.html">contents/raspberry_pi_setup/uart_configuration</a>.</p>
