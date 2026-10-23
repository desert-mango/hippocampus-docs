# Ethernet


## Pinout


We use the T-568B Pinout for all our ethernet connectors.


<div class="adm adm-attention"><p class="adm-title">Attention</p>

Sometimes the ethernet interface of the Raspberry Pi is lagging. We have not ultimately identified the cause, but the following steps might help with that.



</div>

<div class="adm adm-note"><p class="adm-title">Note</p>

The Bluerobotics Switch is a 100Mbit/s switch. So there is no need to configure the connection to be 100Mbit/s only, because it is 100Mbit/s anyway.




</div>

Most likely the Gigabit connection via our manually crimped RJ45 connectors is not stable. Hence, the connection speed (100 Mbit/s vs Gbit) is repetitively negotiated which results in an unstable connection.


We try to avoid this by manually setting the advertised link mode to 100 MBit/s (`0x008` is 100baseT full duplex).


<div class="adm adm-warning"><p class="adm-title">Warning</p>

The old version of this page used `$ETHTOOL` in an `/etc/network/if-pre-up.d/` hook. That only works with `ifupdown`, which Ubuntu 24.04 Server does not install (it uses netplan and systemd-networkd), so such a hook never runs and `$ETHTOOL` is empty. The steps below replace it. They have **not been tested** against the lag described above; if you try them, please report whether they help.

</div>

To apply the setting until the next reboot (needs the `ethtool` package):


```console
$ sudo ethtool --change eth0 advertise 0x008
```

Changing the link mode renegotiates the link, so an SSH session over `eth0` can drop for a few seconds.


To apply it at every boot, create `/etc/systemd/system/eth0-advertise-100m.service`:


```ini
[Unit]
Description=Advertise only 100 Mbit/s full duplex on eth0
BindsTo=sys-subsystem-net-devices-eth0.device
After=sys-subsystem-net-devices-eth0.device

[Service]
Type=oneshot
ExecStart=/usr/sbin/ethtool --change eth0 advertise 0x008

[Install]
WantedBy=sys-subsystem-net-devices-eth0.device
```

and enable it:


```console
$ sudo systemctl daemon-reload && sudo systemctl enable eth0-advertise-100m.service
```


<p class="provenance">Migrated from the previous docs site: <a href="https://hippocampusrobotics.github.io/docs/contents/raspberry_pi_setup/ethernet.html">contents/raspberry_pi_setup/ethernet</a>.</p>
