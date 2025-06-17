// ====== 設定値 ======
const THRESHOLD_DISTANCE = 5; // ピンを消す（次のピンを表示する）しきい値距離 (メートル)
const PIN_MODEL_SCALE = '0.5 0.5 0.5'; // ピンの3Dモデルのスケール
const PIN_HEIGHT_OFFSET = 1; // 地面からのピンの高さ調整 (メートル)

// ====== グローバル変数 ======
let userLatitude = null;
let userLongitude = null;
let userHeading = 0; // ユーザーが向いている方位 (0:北, 90:東, 180:南, 270:西)

let currentDestinationPinIndex = -1; // 現在案内中のピンのインデックス
let pinsData = []; // 全てのピンのデータ（イベント選択時に設定）

const arPinsContainer = document.querySelector('#ar-pins-container');
const currentLocationSpan = document.querySelector('#current-location');
const destinationInfoSpan = document.querySelector('#destination-info');
const messagePanel = document.querySelector('#message');

// ====== ヘルパー関数 ======

/**
 * 2点間の距離をメートル単位で計算 (Haversine formula)
 * @param {object} p1 - {latitude, longitude}
 * @param {object} p2 - {latitude, longitude}
 * @returns {number} 距離 (メートル)
 */
function calculateDistance(p1, p2) {
    const R = 6371e3; // metres
    const φ1 = p1.latitude * Math.PI / 180; // φ, λ in radians
    const φ2 = p2.latitude * Math.PI / 180;
    const Δφ = (p2.latitude - p1.latitude) * Math.PI / 180;
    const Δλ = (p2.longitude - p1.longitude) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const d = R * c; // in metres
    return d;
}

/**
 * ある地点から別の地点への方位を計算 (北を0度とし、時計回りに360度)
 * @param {object} p1 - {latitude, longitude}
 * @param {object} p2 - {latitude, longitude}
 * @returns {number} 方位 (度)
 */
function calculateBearing(p1, p2) {
    const φ1 = p1.latitude * Math.PI / 180;
    const λ1 = p1.longitude * Math.PI / 180;
    const φ2 = p2.latitude * Math.PI / 180;
    const λ2 = p2.longitude * Math.PI / 180;

    const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return bearing;
}

// ====== 位置情報・方位センサーの取得 ======

// GPS (Geolocation API)
function initGeolocation() {
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (position) => {
                userLatitude = position.coords.latitude;
                userLongitude = position.coords.longitude;
                currentLocationSpan.textContent = `緯度: ${userLatitude.toFixed(6)}, 経度: ${userLongitude.toFixed(6)}`;
                updateARPins(); // 位置が更新されたらARピンを更新
            },
            (error) => {
                console.error('Geolocation error:', error);
                messagePanel.textContent = '位置情報の取得に失敗しました。GPSをオンにしてください。';
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 5000
            }
        );
    } else {
        messagePanel.textContent = 'お使いのブラウザは位置情報をサポートしていません。';
    }
}

// DeviceOrientation (方位センサー)
function initDeviceOrientation() {
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientationabsolute', (event) => {
            // alpha: Z軸周りの回転（方位）。北が0度、東が90度、南が180度、西が270度
            if (event.alpha !== null) {
                userHeading = 360 - event.alpha; // AR.jsの座標系に合わせるため反転
                // console.log("User Heading:", userHeading.toFixed(2));
                updateARPins(); // 方位が更新されたらARピンを更新
            }
        }, true);
    } else {
        messagePanel.textContent = 'お使いのデバイスは方位センサーをサポートしていません。';
    }
}

// ====== ARピンの表示ロジック ======

function updateARPins() {
    if (userLatitude === null || userLongitude === null || pinsData.length === 0) {
        return; // 位置情報が未取得、またはピンデータがない場合は何もしない
    }

    // 古いピンをすべて削除
    while (arPinsContainer.firstChild) {
        arPinsContainer.removeChild(arPinsContainer.firstChild);
    }

    // 現在案内中のピンの情報を取得
    const currentPin = pinsData[currentDestinationPinIndex];
    if (!currentPin) {
        messagePanel.textContent = '目的地に到着しました！';
        destinationInfoSpan.textContent = 'イベント会場';
        return; // 全てのピンを案内し終えた
    }

    destinationInfoSpan.textContent = currentPin.name;

    // ユーザーと現在のピンの距離と方位を計算
    const distance = calculateDistance(
        { latitude: userLatitude, longitude: userLongitude },
        { latitude: currentPin.latitude, longitude: currentPin.longitude }
    );
    const bearing = calculateBearing(
        { latitude: userLatitude, longitude: userLongitude },
        { latitude: currentPin.latitude, longitude: currentPin.longitude }
    );

    messagePanel.textContent = `残り距離: ${distance.toFixed(1)}m`;

    // しきい値距離より近づいたら次のピンへ
    if (distance < THRESHOLD_DISTANCE) {
        currentDestinationPinIndex++;
        updateARPins(); // 次のピンをすぐに表示
        return;
    }

    // AR空間におけるピンのXYZ座標を計算
    // 北を基準とした方位とユーザーの向きを考慮
    // AR.jsのカメラは通常Y軸が上方向
    // 緯度経度からメートルへの変換は簡略化（あくまで相対的な位置関係）
    // 緯度1度あたり約111km, 経度1度あたり緯度によって異なるが約90km (日本付近)
    const latDiffMeters = (currentPin.latitude - userLatitude) * 111139; // 約111km/度
    const lonDiffMeters = (currentPin.longitude - userLongitude) * 96486; // 日本付近の経度1度あたりの距離の目安 (約96km/度)

    // Three.js (A-Frame) のZ軸は奥方向、X軸は右方向
    // ユーザーの現在位置と向きに基づいて相対的な位置を計算
    const angleRad = (bearing - userHeading) * Math.PI / 180; // ピンへの方向 - ユーザーの向き

    const x = distance * Math.sin(angleRad); // X軸方向 (右/左)
    const z = -distance * Math.cos(angleRad); // Z軸方向 (奥/手前)

    const y = PIN_HEIGHT_OFFSET; // 地面からの高さ

    // ARピンのエンティティを作成し、コンテナに追加
    const pinEntity = document.createElement('a-entity');
    pinEntity.setAttribute('gltf-model', '#pin-model');
    pinEntity.setAttribute('position', `${x} ${y} ${z}`);
    pinEntity.setAttribute('scale', PIN_MODEL_SCALE);
    // ピンの向きをユーザーの方向に向ける（または進行方向に向ける）
    // ユーザーからピンへの向きにピンの正面が向くように調整
    pinEntity.setAttribute('rotation', `0 ${-angleRad * 180 / Math.PI + 180} 0`); // 向き調整

    arPinsContainer.appendChild(pinEntity);
}

// ====== 初期化 ======

document.addEventListener('DOMContentLoaded', () => {
    // URLのクエリパラメータからイベント情報を取得
    const params = new URLSearchParams(window.location.search);
    const eventId = params.get('event');

    if (eventId) {
        // ここで実際のイベントデータとピンの経路データを読み込む
        // 仮データ (実際にはサーバーから取得するなど)
        switch (eventId) {
            case 'bungaku':
                pinsData = [
                    { name: '文学部棟入口', latitude: 35.8576, longitude: 139.7523 }, // 例：東京ドーム付近
                    { name: '文学部棟2階教室', latitude: 35.8579, longitude: 139.7525 },
                    { name: '文学部イベント会場', latitude: 35.8582, longitude: 139.7527 }
                ];
                break;
            case 'setsumeikai':
                pinsData = [
                    { name: '△△ホール入口', latitude: 35.8560, longitude: 139.7510 },
                    { name: '△△ホール会場', latitude: 35.8563, longitude: 139.7512 }
                ];
                break;
            // 他のイベントのピンデータもここに追加
            default:
                messagePanel.textContent = '指定されたイベントが見つかりません。';
                return;
        }
        currentDestinationPinIndex = 0; // 最初のピンから案内を開始
        destinationInfoSpan.textContent = pinsData[0].name;

        initGeolocation();
        initDeviceOrientation();
        messagePanel.textContent = '位置情報を取得しています...';

    } else {
        messagePanel.textContent = 'イベントが指定されていません。';
    }
});

// A-Frameシーンがロードされた後の処理（必要であれば）
document.querySelector('a-scene').addEventListener('loaded', () => {
    console.log('A-Frame scene loaded.');
});